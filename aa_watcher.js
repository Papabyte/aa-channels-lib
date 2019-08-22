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
		await treatUnitsFromAA(); // we look for units that weren't treated in case node was interrupted at bad time
		setInterval(lookForAndProcessTasks, 5000);
	});
});

if (conf.bLight){
	eventBus.on('my_transactions_became_stable', function(arrUnits){
		console.error("my_transactions_became_stable " +JSON.stringify(arrUnits));
		treatUnitsFromAA(arrUnits);
	});
} else {
	eventBus.on('new_aa_unit', async function(objUnit){
		const channels = await appDB.query("SELECT 1 FROM channels WHERE aa_address=?", [objUnit.authors[0].address]);
		if (channels[0])
			treatUnitsFromAA([objUnit.unit]);
	});
}

eventBus.on('new_my_transactions', function(arrUnits){
	console.error("new_my_transactions " +JSON.stringify(arrUnits));
	if(conf.bLight && !lightWallet.isFirstHistoryReceived())
		return console.error("first history not processed");
	treatNewUnitsFromPeers(arrUnits);
});

eventBus.on('sequence_became_bad', function(arrUnits){
	appDB.query("UPDATE unconfirmed_deposits_from_peer SET is_bad_sequence=1 WHERE unit IN(?)", [arrUnits]);
});


function lookForAndProcessTasks(){
	if(conf.bLight && !lightWallet.isFirstHistoryReceived())
		return console.log("first history not processed");
	if (conf.bLight)
		updateAddressesToWatch();
	confirmClosingIfTimeoutReached();
	if (conf.isHighAvailabilityNode)
		treatClosingRequests();
}

async function updateAddressesToWatch(){
	var watched_addresses = await dagDB.query("SELECT address FROM my_watched_addresses");
	var rows = await appDB.query("SELECT aa_address FROM channels WHERE aa_address NOT IN ('" + watched_addresses.map(function(row){ return row.address }).join("','") + "')");
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
					if (response.unstable_mc_joints)
						response.unstable_mc_joints.forEach(function(objUnit){
							assocJointsFromPeersCache[objUnit.unit.unit] = objUnit.unit;
						})
					light.processHistory(response, objRequest.witnesses, {
						ifError: function(err){
							console.log("error when processing history for " + row.aa_address +" "+ err);
						},
						ifOk: function(){
							console.log("history processed for " + row.aa_address);
							console.error("history processed for " + row.aa_address);
							treatUnitsAndAddWatchedAddress()
						}
					});
				});
			});
		} else {
			treatUnitsAndAddWatchedAddress()
		}

		async function treatUnitsAndAddWatchedAddress(){
			await treatUnitsFromAA();
			await treatNewUnitsFromPeers(null, row.aa_address);
			console.error("treatUnitsFromAA done ");
			console.error("treatNewUnitsFromPeers done ");
			walletGeneral.addWatchedAddress(row.aa_address, () => {
			});
		}
	});
}


async function getSqlFilterForNewUnitsFromChannels(){
	return new Promise(async (resolve, reject) => {
		const rows = await appDB.query("SELECT last_updated_mci,aa_address FROM channels");
		var string = rows.length > 0 ? " (" : " 0 ";
		var i = 0;
		rows.forEach(function(row){
			i++;
			string += " (author_address='" + row.aa_address + "' AND main_chain_index>" + row.last_updated_mci + ") ";
			string += rows.length > i ? " OR " : "";
		});
		string += rows.length > 0 ? ") " : "";
		resolve(string);
	});
}

async function getSqlFilterForNewUnitsFromPeers(aa_address){
	return new Promise(async (resolve, reject) => {
		const rows = await appDB.query("SELECT last_updated_mci,peer_address,aa_address FROM channels " + (aa_address ? " WHERE aa_address='"+aa_address+"'" : ""));
		var string = rows.length > 0 ? " (" : " 0 ";
		var i = 0;
		rows.forEach(function(row){
			i++;
			string += " (outputs.address='" + row.aa_address +"' AND author_address='" + row.peer_address + "' AND (main_chain_index>" + row.last_updated_mci + " OR main_chain_index IS NULL)) ";
			string += rows.length > i ? " OR " : "";
		});
		string += rows.length > 0 ? ") " : "";
		resolve(string);
	});
}



function treatNewUnitsFromPeers(arrUnits, aa_address){
	return new Promise(async (resolve, reject_1) => {
		mutex.lockOrSkip(['treatNewUnitsFromPeers'], async (unlock) => {
			const unitFilter = arrUnits ? " units.unit IN(" + arrUnits.map(dagDB.escape).join(',') + ") AND " : "";

			const new_units = await dagDB.query("SELECT timestamp,units.unit,main_chain_index,unit_authors.address AS author_address FROM units \n\
			CROSS JOIN unit_authors USING(unit)\n\
			CROSS JOIN outputs USING(unit)\n\
			WHERE "+ unitFilter + await getSqlFilterForNewUnitsFromPeers(aa_address));
			if (new_units.length === 0){
				unlock();
				console.error("nothing concerns peers in these units");
				console.log("nothing concerns peers in these units");
				return resolve();
			}
			for (var i = 0; i < new_units.length; i++){
				var new_unit = new_units[i];
				console.error("will treat "+ new_unit.author_address);
				var channels = await appDB.query("SELECT aa_address FROM channels WHERE peer_address=?", [new_unit.author_address]);
				if (!channels[0])
					throw Error("channel not found");
				await	treatNewUnitToChannel(channels, new_unit);
			}
			unlock();
			resolve();
		});
	});
}

function treatNewUnitToChannel(channels, new_unit){
	return new Promise(async (resolve, reject) => {
		async.eachSeries(channels, function(channel, eachCb){
			mutex.lock([channel.aa_address], async function(unlock_aa){
				var conn = await takeAppDbConnectionAsync();
				if (conf.isHighAvailabilityNode) {
					var connOrDagDB = dagDB;
					var results = await	conn.query("SELECT GET_LOCK(?,1) as my_lock",[new_unit.author_address]);
					if (!results[0].my_lock || results[0].my_lock === 0){
						 console.error("couldn't get lock from MySQL " + new_unit.author_address);
						 conn.release();
						 unlock_aa();
						 eachCb();
						return console.log("couldn't get lock from MySQL " + new_unit.author_address);
					}
				} else{
					var connOrDagDB = conn;
				}
				var lockedChannelRows = await appDB.query("SELECT * FROM channels WHERE aa_address=?", [channel.aa_address]);
				var lockedChannel = lockedChannelRows[0];
				var byteAmountRows = await connOrDagDB.query("SELECT amount FROM outputs WHERE unit=? AND address=? AND asset IS NULL", [new_unit.unit, channel.aa_address]);
				console.error("byteAmountRows " + JSON.stringify(byteAmountRows));
				var byteAmount = byteAmountRows[0] ? byteAmountRows[0].amount : 0;
				if (byteAmount >= 10000){
					console.error("received more than 10000 bytes")
					var sqlAsset = lockedChannel.asset == 'base' ? "" : " AND asset="+channel.asset +" ";
					var amountRows = await connOrDagDB.query("SELECT amount FROM outputs WHERE unit=? AND address=?" + sqlAsset, [new_unit.unit, channel.aa_address]);
					var amount = amountRows[0].amount;

					var bHasDefinition = false;
					var bHasData = false;
					console.error("will find " + new_unit.unit + " in cache");

					var joint = await getJointFromCacheStorageOrHub(connOrDagDB, new_unit.unit);
					if (joint){
						joint.messages.forEach(function(message){
							console.error(message.payload.app + " "+ channel.aa_address);
							if (message.app == "definition" && message.payload.address == channel.aa_address){
								bHasDefinition = true;
								console.error("bHasDefinition true");
							}
							if (message.app == "data")
								bHasData = true;
						});
						console.error("lockedChannel.status " + lockedChannel.status);
						console.error("lockedChannel.is_definition_confirmed " + lockedChannel.is_definition_confirmed);
						if (lockedChannel.status == "created" || lockedChannel.status == "close"|| lockedChannel.status == "open"){
							var unconfirmedDepositRows = await conn.query("SELECT close_channel,has_definition FROM unconfirmed_deposits_from_peer WHERE aa_address=?", [channel.aa_address]);
							var bAlreadyBeenClosed = unconfirmedDepositRows.some(function(row){return row.close_channel});
							console.error("bAlreadyBeenClosed " + bAlreadyBeenClosed);
							if (!bAlreadyBeenClosed && (lockedChannel.is_definition_confirmed === 1 || bHasDefinition)){
								if (bHasData)
									await conn.query("REPLACE INTO unconfirmed_deposits_from_peer (aa_address,close_channel,unit) VALUES (?,1,?)",[ channel.aa_address,new_unit.unit]);
								else if (lockedChannel.asset != 'base' || byteAmount > 10000)
									await conn.query("INSERT " + conn.getIgnore() + " INTO unconfirmed_deposits_from_peer (aa_address,amount,unit,has_definition) VALUES (?,?,?,?)",[ channel.aa_address, amount, new_unit.unit, bHasDefinition ? 1 : 0]);
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
	return new Promise(async (resolve, reject) => {
		if (assocJointsFromPeersCache[unit])
		 return resolve(assocJointsFromPeersCache[unit]);
		 console.error("joint not in cache");
		if (!conf.bLight){
			return require('ocore/storage.js').readJoint(conn, unit, {
				ifFound: function(objJoint){
					console.error("joint read in storage");
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
				console.error("joint received from hub");
				resolve(response.joint.unit)
			} else {
				resolve();
			}
		});
		setTimeout(resolve, 1000);
	});
}

function takeAppDbConnectionAsync(){
	return new Promise(async (resolve, reject) => {
		appDB.takeConnectionFromPool(function(conn) {
			resolve(conn);
		});
	});
}

function treatUnitsFromAA(arrUnits){
	return new Promise(async (resolve_1, reject_1) => {
		mutex.lockOrSkip(['treatUnitsFromAA'], async (unlock) => {
			const unitFilter = arrUnits ? " units.unit IN(" + arrUnits.map(dagDB.escape).join(',') + ") AND " : "";
			const isStableFilter = conf.bLight ? " AND is_stable=1 AND sequence='good' " : "";

			const new_units = await dagDB.query("SELECT timestamp,units.unit,main_chain_index,unit_authors.address AS author_address FROM units \n\
			CROSS JOIN unit_authors USING(unit)\n\
			WHERE "+ unitFilter + await getSqlFilterForNewUnitsFromChannels() + isStableFilter + " GROUP BY units.unit ORDER BY main_chain_index,level ASC");
			console.error("new_units " + JSON.stringify(new_units));

			if (new_units.length === 0){
				unlock();
				resolve_1();
				return console.log("nothing concerns payment channel in these units");
			}

			for (var i = 0; i < new_units.length; i++){
				var new_unit = new_units[i];
				await treatUnitFromAA(new_unit);
			}
			unlock();
			resolve_1();
		});
	});
}


function treatUnitFromAA(new_unit){
	return new Promise(async (resolve, reject) => {
		mutex.lock([new_unit.author_address], async function(unlock_aa){
			console.error("will take conn");
			var conn = await takeAppDbConnectionAsync();
			console.error("conn taken");
			if (conf.isHighAvailabilityNode) {
				var connOrDagDB = dagDB;

				var results = await	conn.query("SELECT GET_LOCK(?,1) as my_lock",[new_unit.author_address]);
				if (!results[0].my_lock || results[0].my_lock === 0){
					unlock_aa();
					conn.release();
					console.error("couldn't get lock from MySQL for " + new_unit.author_address);
					console.log("couldn't get lock from MySQL");
					return resolve();
				}
			} else{
				var connOrDagDB = conn;
			}
			console.error("will query channels");
			var channels = await conn.query("SELECT * FROM channels WHERE aa_address=?", [new_unit.author_address]);
			console.log("channels " + JSON.stringify(channels));

			if (!channels[0])
				throw Error("channel not found");
				console.error("will query payloads");
				var payloads = await connOrDagDB.query("SELECT payload FROM messages WHERE unit=? AND app='data' ORDER BY message_index ASC LIMIT 1", [new_unit.unit]);

			console.log("payloads " + JSON.stringify(payloads));

			var channel = channels[0];
			var payload = payloads[0] ? JSON.parse(payloads[0].payload) : null;
			console.log("channel " + JSON.stringify(channel));

			function setLastUpdatedMciAndEventIdAndOtherFields(fields){
				return new Promise(async (resolve_2, reject_2) => {
					console.error("will update fields " + JSON.stringify(fields));
					var strSetFields = "";
					if (fields)
						for (var key in fields){
							strSetFields += "," + key + "='" + fields[key] + "'";
						}
					await conn.query("UPDATE channels SET last_updated_mci=?,last_event_id=?,is_definition_confirmed=1" + strSetFields + " WHERE aa_address=? AND last_event_id<?", [new_unit.main_chain_index, payload.event_id, new_unit.author_address, payload.event_id]);
					return resolve_2();
				});
			}
			console.log("payload " + JSON.stringify(payload));
			if (payload && payload.trigger_unit){
				await conn.query("DELETE FROM unconfirmed_deposits_from_peer WHERE unit=?", [payload.trigger_unit]);
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
	return new Promise((resolve, reject) => {
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


