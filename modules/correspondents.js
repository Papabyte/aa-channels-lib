/*jslint node: true */
'use strict';

const db = require('ocore/db');

function addCorrespondent(code, name, cb) {
	let device = require('ocore/device');

	function handleCode(code) {
		let matches = code.match(/^([\w\/+]+)@([\w.:\/-]+)#([\w\/+-]+)$/);
		if (!matches)
			return cb("Invalid pairing code");
		let pubkey = matches[1];
		let hub = matches[2];
		let pairing_secret = matches[3];
		if (pubkey.length !== 44)
			return cb("Invalid pubkey length");

		acceptInvitation(hub, pubkey, pairing_secret, cb);
	}

	function acceptInvitation(hub_host, device_pubkey, pairing_secret, cb) {
		if (device_pubkey === device.getMyDevicePubKey())
			return cb("cannot pair with myself");
		if (!device.isValidPubKey(device_pubkey))
			return cb("invalid peer public key");
		// the correspondent will be initially called 'New', we'll rename it as soon as we receive the reverse pairing secret back
		device.addUnconfirmedCorrespondent(device_pubkey, hub_host, name, (device_address) => {
			device.startWaitingForPairing((reversePairingInfo) => {
				device.sendPairingMessage(hub_host, device_pubkey, pairing_secret, reversePairingInfo.pairing_secret, {
					ifOk: () =>{
						cb(null, device_address);
					},
					ifError: cb
				});
			});
		});
	}

	handleCode(code);
};

function findCorrespondentByPairingCode(code, cb) {
	let matches = code.match(/^([\w\/+]+)@([\w.:\/-]+)#([\w\/+-]+)$/);
	if (!matches)
		return cb("Invalid pairing code");
	let pubkey = matches[1];
	let hub = matches[2];

	db.query("SELECT device_address FROM correspondent_devices WHERE pubkey = ? AND hub = ?", [pubkey, hub], (rows) => {
		return cb(rows.length ? rows[0] : null);
	});
};

exports.findOrAddCorrespondentByPairingCode = (code) => {
	return new Promise((resolve) => {
		findCorrespondentByPairingCode(code, (correspondent) => {
			if (!correspondent){
				addCorrespondent(code, 'Payment channel peer', (err, device_address) => {
					if (err){
						console.log("error when adding correspondent "+ err);
						return resolve(null);
					}
					resolve(device_address);
				});
			} else {
				resolve(correspondent.device_address);
			}
		});
	});
}