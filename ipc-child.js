// Shared messaging for Electron utilityProcess and Node child_process.fork
module.exports = function channel(onMessage) {
  if (process.parentPort) {
    process.parentPort.on('message', e => onMessage(e.data));
    return msg => process.parentPort.postMessage(msg);
  }
  process.on('message', onMessage);
  process.on('disconnect', () => process.exit(0));
  return msg => process.send && process.send(msg);
};
