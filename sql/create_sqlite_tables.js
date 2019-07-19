/*jslint node: true */

/* 
* when this lib is configured to use internal Obyte node DB, the tables are created at start if not existing
* if you use your own external DB, you have to create tables by yourself
*/

"use strict";
const db = require('ocore/db.js');

db.query("CREATE TABLE IF NOT EXISTS channels (  \n\
	aa_address CHAR(32) PRIMARY KEY, \n\
	version INTEGER,\n\
	salt CHAR(60) UNIQUE NOT NULL,\n\
	definition TEXT,\n\
	peer_address CHAR(32) NOT NULL, \n\
	peer_device_address CHAR(33) DEFAULT NULL, \n\
	peer_url VARCHAR(100) DEFAULT NULL,\n\
	amount_spent_by_peer INTEGER DEFAULT 0,\n\
	amount_spent_by_me INTEGER DEFAULT 0,\n\
	amount_deposited_by_peer INTEGER DEFAULT 0,\n\
	amount_deposited_by_me INTEGER DEFAULT 0,\n\
	auto_fill_threshold INTEGER DEFAULT 0,\n\
	auto_fill_amount INTEGER DEFAULT 0,\n\
	close_timestamp INTEGER,\n\
	period INTEGER DEFAULT 1,\n\
	last_message_from_peer TEXT,\n\
	last_event_id INTEGER DEFAULT 0,\n\
	closing_authored TINYINT DEFAULT 0,\n\
	status VARCHAR(30) DEFAULT 'created',\n\
	last_updated_mci INTEGER DEFAULT 0,\n\
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP\n\
);");



db.query("CREATE TABLE IF NOT EXISTS channels_config (\n\
	my_address CHAR(32) \n\
	);");