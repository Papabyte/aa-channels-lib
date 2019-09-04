exports.bServeAsHub = false;
exports.bLight = true;
exports.bSingleAddress = true; // should always be true!

exports.WS_PROTOCOL = "ws://";
exports.hub = process.env.testnet ? 'obyte.org/bb-test' : 'obyte.org/bb';
exports.deviceName = 'AA-channel-lib';
exports.permanent_pairing_secret = '0000';
exports.control_addresses = [''];

exports.minChannelTimeoutInSecond = 800;
exports.maxChannelTimeoutInSecond = 1500;
exports.defaultTimeoutInSecond = 1000;

exports.isHighAvailabilityNode =  false;

exports.unconfirmedAmountsLimitsByAssetOrChannel = {
	"base" : {
		max_unconfirmed_by_asset : 1e6,
		max_unconfirmed_by_channel : 1e6,
		minimum_time_in_second : 5
	}
}

exports.enabledReceivers = ['http','obyte-messenger']; //configure the communication layers that can receive a message from peer
// if 'http' is present, a http server will start to listen at port httpDefaultPort
// if 'obyte-messenger' is present, messages incoming through the encypted chat layers will be treated (not possible in High availability mode)

exports.httpDefaultPort = 6800;

console.log('finished AA-channel-lib conf');
