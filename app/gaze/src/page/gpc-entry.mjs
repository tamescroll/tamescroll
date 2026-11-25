// Entry for the GPC page bundle: asks the phone whether the switch is on
// (MainActivity's TsGpc bridge, a single boolean, safe for any page to
// read) and installs the signal. No bridge, no signal: desktop and iPhone
// have no such switch yet.
import { installGpc } from './gpc.mjs';

installGpc(globalThis, () => {
  const bridge = globalThis.TsGpc;
  return !!(bridge && typeof bridge.on === 'function' && bridge.on() === true);
});
