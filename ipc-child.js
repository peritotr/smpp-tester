// Shared messaging for Electron utilityProcess and Node child_process.fork
module.exports = function channel(onMessage) {
  if (process.parentPort) {
    process.parentPort.on('message', e => onMessage(e.data));
    return msg => process.parentPort.postMessage(msg);
  }
  process.on('message', onMessage);
  process.on('disconnect', () => setImmediate(() => process.exit(0))); // let other disconnect handlers (e.g. closing the DLR journal) run first
  return msg => process.send && process.send(msg);
};
