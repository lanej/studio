import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, delimiter, join } from 'node:path';

const fingerprint = info => [info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].map(String).join(':');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function image(path, vnode) {
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor, {bigint:true});
    if (vnode && (before.dev !== vnode.device || before.ino !== vnode.inode))
      throw new Error('Mapped Bun vnode changed before image inspection');
    const sha256 = hash(readFileSync(descriptor));
    const current = fingerprint(before);
    if (current !== fingerprint(fstatSync(descriptor, {bigint:true})) ||
        current !== fingerprint(statSync(path, {bigint:true})))
      throw new Error('Bun image or pathname changed during inspection');
    return {path, sha256, fingerprint:current};
  } finally { closeSync(descriptor); }
}
function versionQualifies(version, minimum) {
  const expected = /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(minimum);
  const actual = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/u.exec(version);
  if (!expected || !actual) return false;
  for (let index=1; index<=3; index++) {
    if (Number(actual[index]) !== Number(expected[index])) return Number(actual[index]) > Number(expected[index]);
  }
  return true;
}
export function selectedHost(minimum) {
  let path, selection;
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, 'bun');
    try { accessSync(candidate, constants.X_OK); path=realpathSync(candidate); selection=candidate; break; } catch { /* Next environment candidate. */ }
  }
  if (!path) throw new Error('A qualifying shared Bun runtime is required on PATH');
  const before=statSync(path,{bigint:true});
  const result = spawnSync(path, ['--no-env-file', '--config='+new URL('../resources/bunfig.toml',import.meta.url).pathname, '--version'], {encoding:'utf8'});
  const version = result.stdout?.trim() ?? '';
  if (result.status !== 0 || !versionQualifies(version, minimum)) throw new Error('The selected shared Bun runtime does not satisfy '+minimum);
  const observed=image(path);
  if (fingerprint(before)!==observed.fingerprint || realpathSync(selection)!==path) throw new Error('Selected shared Bun changed during version inspection');
  return {path,sha256:observed.sha256,minimum,version};
}
let mapped;
export function mappedHost() {
  if (mapped) {
    if (fingerprint(statSync(mapped.path,{bigint:true}))!==mapped.fingerprint) throw new Error('Mapped shared Bun file changed after native startup');
    return mapped;
  }
  let path, vnode;
  if (process.platform==='linux') path='/proc/'+process.pid+'/exe';
  else if (process.platform==='darwin') {
    const result=spawnSync('/usr/sbin/lsof',['-a','-p',String(process.pid),'-d','txt','-F','Din'],{encoding:'utf8'});
    if (result.status!==0) throw new Error('Mapped shared Bun vnode inspection is unavailable');
    let device, inode;
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('D')) device=BigInt(line.slice(1).startsWith('0x') ? line.slice(1) : '0x'+line.slice(1));
      else if (line.startsWith('i')) inode=BigInt(line.slice(1));
      else if (line.startsWith('n') && basename(line.slice(1))===basename(process.execPath)) {
        const candidate=line.slice(1);
        const info=statSync(candidate,{bigint:true});
        if (info.dev===device && info.ino===inode) {path=candidate;vnode={device,inode};break;}
      }
    }
  }
  if (!path) throw new Error('The native mapped Bun executable was not verified');
  mapped=image(path,vnode);
  return mapped;
}
export function runtimeIdentity(bundle, host, minimum) {
  return hash(JSON.stringify({bundle,bun_sha256:host,minimum}));
}
