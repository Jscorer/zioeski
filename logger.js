const COLOURS = {
  ready: "\x1b[32m",  // green
  info:  "\x1b[36m",  // cyan
  msg:   "\x1b[37m",  // white
  wait:  "\x1b[33m",  // yellow
  sent:  "\x1b[35m",  // magenta
  skip:  "\x1b[90m",  // grey
  error: "\x1b[31m",  // red
};
const RESET = "\x1b[0m";

function log(type, text) {
  const colour = COLOURS[type] || "\x1b[37m";
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const tag = `[${type.toUpperCase()}]`.padEnd(8);
  console.log(`${colour}${time} ${tag}${RESET} ${text}`);
}

module.exports = { log };
