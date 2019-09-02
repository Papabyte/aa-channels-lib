/*jslint node: true */
'use strict';
const dagDB = require('ocore/db.js');
const walletGeneral = require('ocore/wallet_general.js');
const conf = require('ocore/conf.js');
const eventBus = require('ocore/event_bus.js');
const mutex = require('ocore/mutex.js');
const headlessWallet = require('headless-obyte');
const objectHash = require('ocore/object_hash.js');
const async = require('async');
const myWitnesses = require('ocore/my_witnesses.js');
const light = require('ocore/light.js');
const lightWallet = require('ocore/light_wallet.js');
const constants = require('ocore/constants.js');

if (!conf.isHighAvailabilityNode){
	require('./sql/create_sqlite_tables.js');
	var appDB = require('ocore/db.js');
} else {
	require('./sql/create_mysql_tables.js');
	var appDB = require('./modules/external_db.js');
}

var my_address;
const assocJointsFromPeersCache = {};

eventBus.once('headless_wallet_ready', function(){
	headlessWallet.readFirstAddress(async function(_my_address){
		my_address = _my_address;
		await appDB.query("INSERT " + appDB.getIgnore() + " INTO channels_config (my_address) VALUES (?)", [_my_address]);
		await treatStableUnitsFromAA(); // we look for units that weren't treated in case node was interrupted at bad time
		setInterval(lookForAndProcessTasks, 2000);
	});
});

if (conf.bLight){
	eventBus.on('my_transactions_became_stable', function(arrUnits){
		treatStableUnitsFromAA(arrUnits);
	});
} else {
	eventBus.on('new_aa_unit', async function(objUnit){
		const channels = await appDB.query("SELECT 1 FROM channels WHERE aa_address=?", [objUnit.authors[0].address]);
		if (channels[0])
			treatStableUnitsFromAA([objUnit.unit]);
	});
}

eventBus.on('new_my_transactions', function(arrUnits){
	if(conf.bLight && !lightWallet.isFirstHistoryReceived()) // we ignore all new transactions that could come from a node resyncing from scratch - to do: find solution for full node
		return console.log("first history not processed");
	treatNewUnitsToAA(arrUnits);
});

eventBus.on('sequence_became_bad', function(arrUnits){
	appDB.query("UPDATE unconfirmed_units_from_peer SET is_bad_sequence=1 WHERE unit IN(?)", [arrUnits]);
});


function lookForAndProcessTasks(){ // main loop for repetitive tasks
	if(conf.bLight && !lightWallet.isFirstHistoryReceived())
		return console.log("first history not processed");
	if (conf.bLight)
		updateAddressesToWatch();
	confirmClosingIfTimeoutReached();
	deletePendingUnconfirmedUnits();
	if (conf.isHighAvailabilityNode)
		treatClosingRequests();
}

// some unconfirmed units may be left if unit from AA were disorderly received
async function deletePendingUnconfirmedUnits(){
	const unconfirmedUnitsRows = await appDB.query("SELECT unit FROM unconfirmed_units_from_peer");
	if (unconfirmedUnitsRows.length === 0)
		return;
	const mciAndUnitsRows = await dagDB.query("SELECT main_chain_index,unit FROM units WHERE unit IN ('"+ unconfirmedUnitsRows.map(function(row){ return row.unit }).join("','") + "') AND is_stable=1");
	if (mciAndUnitsRows.length === 0)
		return;
	const sqlFilter = mciAndUnitsRows.map(function(row){
		return "(unit='" + row.unit + "' AND last_updated_mci>="+ row.main_chain_index+")";
	}).join(" OR ");
	appDB.query("DELETE FROM unconfirmed_units_from_peer WHERE unit IN (\n\
		SELECT unit FROM unconfirmed_units_from_peer INNER JOIN channels USING (aa_address) WHERE " + sqlFilter +")");
}

async function updateAddressesToWatch(){
	var watched_addresses = (await dagDB.query("SELECT address FROM my_watched_addresses")).map(function(row){ return row.address }).join("','");
	var rows = await appDB.query("SELECT aa_address FROM channels WHERE aa_address NOT IN ('" + watched_addresses + "')");
	rows.forEach(function(row){
		if (conf.bLight){
			myWitnesses.readMyWitnesses(async function(witnesses){
				const objRequest = {addresses: [row.aa_address], witnesses: witnesses};
				const network = require('ocore/network.js');
				network.requestFromLightVendor('light/get_history', objRequest,  function(ws, request, response){
					if (response.error || (!response.joints && !response.unstable_mc_joints))
						return walletGeneral.addWatchedAddress(row.aa_address, () => {});
					if (response.joints)
						response.joints.forEach(function(objUnit){
							assocJointsFromPeersCache[objUnit.unit.unit] = objUnit.unit;
						})
					light.processHistory(response, objRequest.witnesses, {
						ifError: function(err){
							console.log("error when processing history for " + row.aa_address +" "+ err);
						},
						ifOk: function(){
							console.log("history processed for " + row.aa_address);
							treatUnitsAndAddWatchedAddress()
						}
					});
				});
			});
		} else {
			treatUnitsAndAddWatchedAddress()
		}

		async function treatUnitsAndAddWatchedAddress(){
			await treatStableUnitsFromAA(); // we treat units from AA first to get more recent confirmed states
			await treatNewUnitsToAA(null, row.aa_address); 
			walletGeneral.addWatchedAddress(row.aa_address, () => {
			});
		}
	});
}


async function getSqlFilterForNewUnitsFromChannels(){
	return new Promise(async (resolve) => {
		const rows = await appDB.query("SELECT last_updated_mci,aa_address FROM channels");
		if (rows.length === 0)
			return resolve(" 0 ");
		var string = rows.map(function(row){
			return " (author_address='" + row.aa_address + "' AND main_chain_index>" + row.last_updated_mci + ") ";
		}).join(' OR ');
		resolve(string);
	});
}

async function getSqlFilterForNewUnitsFromPeers(aa_address){
	return new Promise(async (resolve) => {
		const rows = await appDB.query("SELECT last_updated_mci,peer_address,aa_address FROM channels " + (aa_address ? " WHERE aa_address='"+aa_address+"'" : ""));
		if (rows.length === 0)
			return resolve(" 0 ");
		var string = rows.map(function(row){
			return " (outputs.address='" + row.aa_address +"' AND author_address='" + row.peer_address + "' AND (main_chain_index>" + row.last_updated_mci + " OR main_chain_index IS NULL)) ";
		}).join(' OR ');
		resolve(string);
	});
}


function treatNewUnitsToAA(arrUnits, aa_address){
	return new Promise(async (resolve) => {
		mutex.lock(['treatNewUnitsToAA'], async (unlock) => {
			const unitFilter = arrUnits ? " units.unit IN(" + arrUnits.map(dagDB.escape).join(',') + ") AND " : "";
			// we select units having output address and author matching known channels
			const new_units = await dagDB.query("SELECT DISTINCT timestamp,units.unit,main_chain_index,unit_authors.address AS author_address FROM units \n\
			CROSS JOIN unit_authors USING(unit)\n\
			CROSS JOIN outputs USING(unit)\n\
			WHERE "+ unitFilter + await getSqlFilterForNewUnitsFromPeers(aa_address));
			if (new_units.length === 0){
				unlock();
				console.log("nothing destinated to AA in these units");
				return resolve();
			}
			for (var i = 0; i < new_units.length; i++){
				var new_unit = new_units[i];
				var channels = await appDB.query("SELECT aa_address FROM channels WHERE peer_address=?", [new_unit.author_address]);
				if (!channels[0])
					throw Error("channel not found");
				await	treatNewOutputsToChannels(channels, new_unit);
			}
			unlock();
			resolve();
		});
	});
}

function treatNewOutputsToChannels(channels, new_unit){
	return new Promise(async (resolve) => {
		async.eachSeries(channels, function(channel, eachCb){
			mutex.lock([channel.aa_address], async function(unlock_aa){
				var conn = await takeAppDbConnectionPromise();
				if (conf.isHighAvailabilityNode) {
					var connOrDagDB = dagDB;
					var results = await	conn.query("SELECT GET_LOCK(?,1) as my_lock",[new_unit.author_address]);
					if (!results[0].my_lock || results[0].my_lock === 0){
						 conn.release();
						 unlock_aa();
						 eachCb();
						return console.log("couldn't get lock from MySQL " + new_unit.author_address);
					}
				} else{
					var connOrDagDB = conn;
				}
				var lockedChannelRows = await connOrDagDB.query("SELECT * FROM channels WHERE aa_address=?", [channel.aa_address]);
				var lockedChannel = lockedChannelRows[0];
				var byteAmountRows = await connOrDagDB.query("SELECT SUM(amount) AS amount FROM outputs WHERE unit=? AND address=? AND asset IS NULL", [new_unit.unit, channel.aa_address]);
				var byteAmount = byteAmountRows[0] ? byteAmountRows[0].amount : 0;
				if (byteAmount >= constants.MIN_BYTES_BOUNCE_FEE){ // check the minimum to not be bounced is reached 
					var sqlAsset = lockedChannel.asset == 'base' ? "" : " AND asset='"+lockedChannel.asset +"' ";
					var amountRows = await connOrDagDB.query("SELECT SUM(amount) AS amount  FROM outputs WHERE unit=? AND address=?" + sqlAsset, [new_unit.unit, channel.aa_address]);
					var amount = amountRows[0].amount;

					var bHasDefinition = false;
					var bHasData = false;

					var joint = await getJointFromCacheStorageOrHub(connOrDagDB, new_unit.unit);
					if (joint){
						joint.messages.forEach(function(message){
							if (message.app == "definition" && message.payload.address == channel.aa_address){
								bHasDefinition = true;
							}
							if (message.app == "data")
								bHasData = true;
						});
						// for this 3 statuses, we can take into account unconfirmed deposits since they shouldn't be refused by AA
						if (lockedChannel.status == "created" || lockedChannel.status == "closed"|| lockedChannel.status == "open"){
							var unconfirmedUnitsRows = await conn.query("SELECT close_channel,has_definition FROM unconfirmed_units_from_peer WHERE aa_address=?", [channel.aa_address]);
							var bAlreadyBeenClosed = unconfirmedUnitsRows.some(function(row){return row.close_channel});
							if (!bAlreadyBeenClosed && (lockedChannel.is_definition_confirmed === 1 || bHasDefinition)){ // we ignore unit if a closing request happened or no pending/confirmed definition is known
								var timestamp = Math.round(Date.now() / 1000);
								if (bHasData) // a deposit shouldn't have data, if it has data we consider it's a closing request and we flag it as so
									await conn.query("INSERT  " + conn.getIgnore() + " INTO unconfirmed_units_from_peer (aa_address,close_channel,unit,timestamp) VALUES (?,1,?,?)",
									[ channel.aa_address,new_unit.unit, timestamp]);
								else if (lockedChannel.asset != 'base' || byteAmount > 10000) // deposit in bytes are possible only over 10000
									await conn.query("INSERT  " + conn.getIgnore() + " INTO unconfirmed_units_from_peer (aa_address,amount,unit,has_definition,timestamp) VALUES (?,?,?,?,?)",
									[ channel.aa_address, amount, new_unit.unit, bHasDefinition ? 1 : 0, timestamp]);
							}
						}
					}
				}
				if (conf.isHighAvailabilityNode)
					await	conn.query("DO RELEASE_LOCK(?)",[new_unit.author_address]);
				conn.release();
				unlock_aa();
				eachCb();
			});
		}, function() {
			resolve();
		});
	});
}

function getJointFromCacheStorageOrHub(conn, unit){
	return new Promise(async (resolve) => {
		if (assocJointsFromPeersCache[unit])
		 return resolve(assocJointsFromPeersCache[unit]);
		if (!conf.bLight){
			return require('ocore/storage.js').readJoint(conn, unit, {
				ifFound: function(objJoint){
					return resolve(objJoint.unit);
				},
				ifNotFound: function(){
					return resolve();
				}
			});
		}
		const network = require('ocore/network.js');
		network.requestFromLightVendor('get_joint', unit,  function(ws, request, response){
			if (response.joint){
				resolve(response.joint.unit)
			} else {
				resolve();
			}
		});
		setTimeout(resolve, 1000);
	});
}

function takeAppDbConnectionPromise(){
	return new Promise(async (resolve) => {
		appDB.takeConnectionFromPool(function(conn) {
			resolve(conn);
		});
	});
}

function treatStableUnitsFromAA(arrUnits){
	return new Promise(async (resolve_1) => {
		mutex.lock(['treatStableUnitsFromAA'], async (unlock) => {
			const unitFilter = arrUnits ? " units.unit IN(" + arrUnits.map(dagDB.escape).join(',') + ") AND " : "";
			const isStableFilter = conf.bLight ? " AND is_stable=1 AND sequence='good' " : ""; // unit from AA from can always be considered as stable on full node

			const new_units = await dagDB.query("SELECT timestamp,units.unit,main_chain_index,unit_authors.address AS author_address FROM units \n\
			CROSS JOIN unit_authors USING(unit)\n\
			WHERE "+ unitFilter + await getSqlFilterForNewUnitsFromChannels() + isStableFilter + " GROUP BY units.unit ORDER BY main_chain_index,level ASC");

			if (new_units.length === 0){
				unlock();
				resolve_1();
				return console.log("nothing concerns payment channel in these units");
			}

			for (var i = 0; i < new_units.length; i++){
				var new_unit = new_units[i];
				await treatStableUnitFromAA(new_unit);
			}
			unlock();
			resolve_1();
		});
	});
}


function treatStableUnitFromAA(new_unit){
	console.error(new_unit.author_address + " " + new_unit.unit);
	return new Promise(async (resolve) => {
		mutex.lock([new_unit.author_address], async function(unlock_aa){
			var conn = await takeAppDbConnectionPromise();
			if (conf.isHighAvailabilityNode) {
				var connOrDagDB = dagDB;

				var results = await	conn.query("SELECT GET_LOCK(?,1) as my_lock",[new_unit.author_address]);
				if (!results[0].my_lock || results[0].my_lock === 0){
					unlock_aa();
					conn.release();
					console.log("couldn't get lock from MySQL for " + new_unit.author_address);
					return resolve();
				}
			} else{
				var connOrDagDB = conn;
			}
			var channels = await conn.query("SELECT * FROM channels WHERE aa_address=?", [new_unit.author_address]);
			if (!channels[0])
				throw Error("channel not found");
			var channel = channels[0];

			var payloads = await connOrDagDB.query("SELECT payload FROM messages WHERE unit=? AND app='data' ORDER BY message_index ASC LIMIT 1", [new_unit.unit]);
			var payload = payloads[0] ? JSON.parse(payloads[0].payload) : null;

			function setLastUpdatedMciAndEventIdAndOtherFields(fields){
				return new Promise(async (resolve_2) => {
					var strSetFields = "";
					if (fields)
						for (var key in fields){
							strSetFields += "," + key + "='" + fields[key] + "'";
						}
					await conn.query("UPDATE channels SET last_updated_mci=?,last_event_id=?,is_definition_confirmed=1" + strSetFields + " WHERE aa_address=? AND last_event_id<?", [new_unit.main_chain_index, payload.event_id, new_unit.author_address, payload.event_id]);
					return resolve_2();
				});
			}

			//once AA state is updated by an unit, we delete the corresponding unit from unconfirmed units table
			if (payload && payload.trigger_unit){
				await conn.query("DELETE FROM unconfirmed_units_from_peer WHERE unit=?", [payload.trigger_unit]);
				delete assocJointsFromPeersCache[payload.trigger_unit];
			}
			//channel is open and received funding
			if (payload && payload.open){
				await conn.query("UPDATE my_deposits SET is_confirmed_by_aa=1 WHERE unit=?", [payload.trigger_unit]);
				await setLastUpdatedMciAndEventIdAndOtherFields({ status: "open", period: payload.period, amount_deposited_by_peer: payload[channel.peer_address], amount_deposited_by_me: payload[my_address] })
				if (payload[my_address] > 0)
					eventBus.emit("my_deposit_became_stable", payload[my_address], payload.trigger_unit);
				else
					eventBus.emit("peer_deposit_became_stable", payload[channel.peer_address], payload.trigger_unit);
			}

			//closing requested by one party
			if (payload && payload.closing){
				if (payload.initiated_by === my_address)
					var status = "closing_initiated_by_me_acknowledged";
				else {
					var status = "closing_initiated_by_peer";
					if (payload[channel.peer_address] >= channel.amount_spent_by_peer){
						confirmClosing(new_unit.author_address, payload.period, channel.overpayment_from_peer); //peer is honest, we send confirmation for closing
					} else {
						await confirmClosing(new_unit.author_address, payload.period, channel.overpayment_from_peer, channel.last_message_from_peer); //peer isn't honest, we confirm closing with a fraud proof
					}
				}
				await setLastUpdatedMciAndEventIdAndOtherFields({ status: status, period: payload.period, close_timestamp: new_unit.timestamp });
			}
			//AA confirms that channel is closed
			if (payload && payload.closed){
				await setLastUpdatedMciAndEventIdAndOtherFields(
					{
						status: "closed",
						is_peer_ready: 0,
						period: payload.period,
						amount_spent_by_peer: 0,
						amount_spent_by_me: 0,
						amount_deposited_by_peer: 0,
						amount_deposited_by_me: 0,
						overpayment_from_peer: 0,
						amount_possibly_lost_by_me: 0,
						last_message_from_peer: ''
					});
				const rows = await dagDB.query("SELECT SUM(amount) AS amount FROM outputs WHERE unit=? AND address=?", [new_unit.unit, my_address]);
				if (payload.fraud_proof)
					eventBus.emit("channel_closed_with_fraud_proof", new_unit.author_address, rows[0] ? rows[0].amount : 0);
				else
					eventBus.emit("channel_closed", new_unit.author_address, rows[0] ? rows[0].amount : 0);
			}
			//AA refused a deposit, we still have to update flag in my_deposits table so it's not considered as pending anymore
			if (payload && payload.refused){
				const result = await appDB.query("UPDATE my_deposits SET is_confirmed_by_aa=1 WHERE unit=?", [payload.trigger_unit]);
				if (result.affectedRows !== 0)
					eventBus.emit("refused_deposit", payload.trigger_unit);
				await setLastUpdatedMciAndEventIdAndOtherFields({});
			}
			if (conf.isHighAvailabilityNode)
				await	conn.query("DO RELEASE_LOCK(?)",[new_unit.author_address]);
			conn.release();
			unlock_aa();
			resolve();
		});
	});
}

// check if frontend authored a closing request, used only in high availability mode
function treatClosingRequests(){
	mutex.lock(['treatClosingRequests'], async function(unlock){
		const rows = await appDB.query("SELECT aa_address,amount_spent_by_peer,amount_spent_by_me,last_message_from_peer, period FROM channels WHERE closing_authored=1");
		if (rows.length === 0)
			return unlock();

		async.eachSeries(rows, function(row, cb){

			const payload = { close: 1, period: row.period };
			if (row.amount_spent_by_me > 0)
				payload.transferredFromMe = row.amount_spent_by_me;
			if (row.amount_spent_by_peer > 0)
				payload.sentByPeer = JSON.parse(row.last_message_from_peer);

			const options = {
				messages: [{
					app: 'data',
					payload_location: "inline",
					payload_hash: objectHash.getBase64Hash(payload),
					payload: payload
				}],
				change_address: my_address,
				base_outputs: [{ address: row.aa_address, amount: 10000 }]
			}
	
			headlessWallet.sendMultiPayment(options, async function(error, unit){
				if (error)
					handle("error when closing channel " + error);
				else
					await appDB.query("UPDATE channels SET status='closing_initiated_by_me',closing_authored=0 WHERE aa_address=?", [row.aa_address]);
				cb();
			});
		},
			function(){
				unlock();
			});

	});
}


function confirmClosing(aa_address, period, overpayment_from_peer, fraud_proof){
	return new Promise((resolve) => {
		mutex.lock(['confirm_' + aa_address], function(unlock){
			if (fraud_proof){
				var payload = { fraud_proof: 1, period: period, sentByPeer: JSON.parse(fraud_proof) };
			} else {
				var payload = { confirm: 1, period: period };
			}
			if (overpayment_from_peer > 0)
				payload.additionnalTransferredFromMe = overpayment_from_peer;

			const options = {
				messages: [{
					app: 'data',
					payload_location: "inline",
					payload_hash: objectHash.getBase64Hash(payload),
					payload: payload
				}],
				change_address: my_address,
				base_outputs: [{ address: aa_address, amount: 10000 }]
			}
	
			headlessWallet.sendMultiPayment(options, async function(error, unit){
				if (error)
					console.log("error when closing channel " + error);
				else
					await appDB.query("UPDATE channels SET status='confirmed_by_me' WHERE aa_address=?", [aa_address]);
				unlock();
				resolve();
			});

		});
	});
}

async function confirmClosingIfTimeoutReached(){
	const current_ts = Math.round(Date.now() / 1000);
	const rows = await appDB.query("SELECT aa_address,period FROM channels WHERE status='closing_initiated_by_me_acknowledged' AND close_timestamp < (? - timeout)", [current_ts]);
	rows.forEach(function(row){
		confirmClosing(row.aa_address, row.period);
	});
}


