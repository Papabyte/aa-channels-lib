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


if (!conf.isHighAvailabilityNode){
	require('./sql/create_sqlite_tables.js');
	var appDB = require('ocore/db.js');
} else {
	require('./sql/create_mysql_tables.js');
	var appDB = require('./modules/external_db.js');
}

var my_address;


eventBus.once('headless_wallet_ready', function(){
	console.error("headless_wallet_ready watcher");
	headlessWallet.readFirstAddress(async function(_my_address){
		my_address = _my_address;
		await appDB.query("INSERT " + appDB.getIgnore() + " INTO channels_config (my_address) VALUES (?)", [_my_address]);
		treatUnitsFromAA(); // we look for units that weren't treated in case node was interrupted at bad time
		setInterval(lookForAndProcessTasks, 5000);
	});
});

if (conf.bLight){
	eventBus.on('my_transactions_became_stable', function(arrUnits){
		treatUnitsFromAA(arrUnits);
	});
} else {
	eventBus.on('new_aa_unit', async function(objUnit){
		const channels = await appDB.query("SELECT 1 FROM channels WHERE aa_address=?", [objUnit.authors[0].address]);
		if (channels[0])
			treatUnitsFromAA([objUnit.unit]);
	});
}


function lookForAndProcessTasks(){
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
		walletGeneral.addWatchedAddress(row.aa_address, () => {
		});
	});
}


async function getSqlFilterForNewUnitsFromChannels(){
	return new Promise(async (resolve, reject) => {
		const rows = await appDB.query("SELECT peer_address,last_updated_mci,aa_address FROM channels");
		var string = rows.length > 0 ? " (" : " 0 ";
		var i = 0;
		rows.forEach(function(row){
			i++;
			//	string += "((outputs.address='"+row.aa_address + "' OR author_address='" + row.aa_address + "') " + " AND main_chain_index>"  + row.last_updated_mci +") ";
			string += "(author_address='" + row.aa_address + "' " + (conf.bLight ? (" AND main_chain_index>" + row.last_updated_mci) : "") + ") ";
			string += rows.length > i ? " OR " : "";
		});
		string += rows.length > 0 ? ") " : "";
		resolve(string);
	});
}



function treatUnitsFromAA(arrUnits){
	mutex.lock(['treatUnitsFromAA'], async (unlock) => {
		const unitFilter = arrUnits ? " units.unit IN(" + arrUnits.map(dagDB.escape).join(',') + ") AND " : "";
		const isStableFilter = conf.bLight ? " AND is_stable=1 AND sequence='good' " : "";

		const new_units = await dagDB.query("SELECT timestamp,units.unit,main_chain_index,unit_authors.address AS author_address FROM units \n\
		CROSS JOIN unit_authors USING(unit)\n\
		WHERE "+ unitFilter + await getSqlFilterForNewUnitsFromChannels() + isStableFilter + " GROUP BY units.unit ORDER BY main_chain_index,level ASC");
		if (new_units.length === 0){
			unlock();
			return console.log("nothing concerns payment channel in these units");
		}



		for (var i = 0; i < new_units.length; i++){
			var new_unit = new_units[i];
			var channels = await appDB.query("SELECT * FROM channels WHERE aa_address=?", [new_unit.author_address]);
			if (!channels[0])
				throw Error("channel not found");

			var payloads = await dagDB.query("SELECT payload FROM messages WHERE unit=? AND app='data' ORDER BY message_index ASC LIMIT 1", [new_unit.unit]);

			var channel = channels[0];
			var payload = payloads[0] ? JSON.parse(payloads[0].payload) : null;

			async function setLastUpdatedMciAndEventIdAndOtherFields(fields){
				return new Promise(async (resolve, reject) => {
					var strSetFields = "";
					if (fields)
						for (var key in fields){
							strSetFields += "," + key + "='" + fields[key] + "'";
						}

					if (conf.isHighAvailabilityNode) {
						appDB.takeappDBectionFromPool(async function(conn) {
							await	conn.query("SELECT GET_LOCK(?,1)",[new_unit.author_address]);
							await conn.query("UPDATE channels SET last_updated_mci=?,last_event_id=?" + strSetFields + " WHERE aa_address=? AND last_event_id<?", [new_unit.main_chain_index, payload.event_id, new_unit.author_address, payload.event_id]);
							await	conn.query("DO RELEASE_LOCK(?)",[new_unit.author_address]);
							return resolve();
						})
					} else {
						await appDB.query("UPDATE channels SET last_updated_mci=?,last_event_id=?" + strSetFields + " WHERE aa_address=? AND last_event_id<?", [new_unit.main_chain_index, payload.event_id, new_unit.author_address, payload.event_id]);
						return resolve();
					}
				});
			}

			//channel is open and received funding
			if (payload && payload.open){
				await appDB.query("UPDATE pending_deposits SET is_confirmed_by_aa=1 WHERE unit=?", [payload.trigger_unit]);
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
				const result = await appDB.query("UPDATE pending_deposits SET is_confirmed_by_aa=1 WHERE unit=?", [payload.trigger_unit]);
				if (result.affectedRows !== 0)
					eventBus.emit("refused_deposit", payload.trigger_unit);
				await setLastUpdatedMciAndEventIdAndOtherFields({});
			}
		}
		unlock();
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


