#!/usr/bin/env node
// Stand-in for arduino-cli in end-to-end tests: logs its arguments and
// returns canned output.
const fs = require("fs");

const args = process.argv.slice(2);
if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(args) + "\n");

const [cmd, sub] = args;
if (cmd === "version") {
  console.log("arduino-cli  Version: 1.5.1-fake");
} else if (cmd === "board" && sub === "list") {
  console.log(JSON.stringify({ detected_ports: [] }));
} else if (cmd === "compile") {
  const dir = args[args.length - 1];
  if (dir.endsWith("broken")) {
    console.error(`${dir}/broken.ino:3:5: error: 'foo' was not declared in this scope`);
    process.exit(1);
  }
  console.log("Sketch uses 924 bytes (2%) of program storage space. Maximum is 32256 bytes.");
  console.log("Global variables use 9 bytes (0%) of dynamic memory, leaving 2039 bytes for local variables. Maximum is 2048 bytes.");
} else if (cmd === "upload") {
  console.error('avrdude: ser_open(): can\'t open device "/dev/ttyFAKE": Device or resource busy');
  process.exit(1);
} else {
  console.log("ok");
}
