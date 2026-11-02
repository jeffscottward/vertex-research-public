// These programs are constructed by the trusted runner, never selected from a
// caller-supplied Dockerfile, entrypoint, argv, image label or workspace script.
export const deploymentPreparationScript = `set -eu
test "$(/usr/local/bin/node --version)" = "v22.13.1"
test "$(/usr/local/bin/bun --version)" = "1.3.14"
test "$(/usr/local/bin/node /opt/pnpm/bin/pnpm.cjs --version)" = "11.16.0"
/usr/local/bin/node /opt/pnpm/bin/pnpm.cjs install --offline --frozen-lockfile --ignore-scripts --package-import-method=copy --store-dir=/opt/offline-store
/usr/local/bin/node /opt/pnpm/bin/pnpm.cjs rebuild esbuild sharp workerd
/usr/local/bin/node /opt/vertex/guard.mjs prepare
rm -rf /tmp/vertex-preparation
`;

export const deploymentGuard = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const root='/workspace';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const fail=()=>{throw new Error('sealed-input-check-failed')};
const within=p=>p===root||p.startsWith(root+'/');
const outputs=['apps/web/dist','apps/web/.wrangler','apps/web/node_modules/.vite-temp','apps/web/node_modules/.vite','node_modules/.vite-temp'];
function normalizeDependencyHardlinks(expected){
  const groups=new Map();
  let count=0,total=0;
  function inventory(dir,depth=0){
    if(depth>128)fail();
    for(const name of fs.readdirSync(dir).sort()){
      if(++count>250000)fail();
      const absolute=path.join(dir,name),rel=path.relative(root,absolute),st=fs.lstatSync(absolute);
      if(st.isDirectory()){inventory(absolute,depth+1);continue;}
      if(!st.isFile())continue;
      if(st.size>134217728||(st.mode&0o6000)||!Number.isSafeInteger(st.nlink)||st.nlink<1)fail();
      total+=st.size;if(total>8589934592)fail();
      if(st.nlink===1)continue;
      // The complete alias set must be dependency-only and already inside the
      // owned preparation tree. A source/store/outside alias is never waived.
      if(expected.has(rel)||!rel.split('/').includes('node_modules')||st.uid!==65532||st.gid!==65532||!Number.isSafeInteger(st.dev)||!Number.isSafeInteger(st.ino))fail();
      const key=st.dev+':'+st.ino,group=groups.get(key);
      if(group){if(group.stat.nlink!==st.nlink||group.stat.size!==st.size||group.stat.mode!==st.mode)fail();group.paths.push(absolute);}
      else groups.set(key,{stat:st,paths:[absolute]});
    }
  }
  inventory(root);
  for(const group of groups.values())if(group.paths.length!==group.stat.nlink)fail();
  for(const group of groups.values()){
    let digest;
    for(const [index,absolute] of group.paths.entries()){
      const parent=path.dirname(absolute);
      if(fs.realpathSync(parent)!==parent)fail();
      const input=fs.openSync(absolute,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      let output,temporary,created;
      try{
        const before=fs.fstatSync(input),named=fs.lstatSync(absolute);
        if(!before.isFile()||before.dev!==group.stat.dev||before.ino!==group.stat.ino||named.dev!==before.dev||named.ino!==before.ino||before.nlink!==group.paths.length-index||before.size!==group.stat.size||before.mode!==group.stat.mode||before.uid!==65532||before.gid!==65532)fail();
        const bytes=Buffer.alloc(before.size);
        let offset=0;
        while(offset<bytes.length){const n=fs.readSync(input,bytes,offset,bytes.length-offset,offset);if(n===0)fail();offset+=n;}
        const after=fs.fstatSync(input),actual=hash(bytes);
        if(after.size!==before.size||after.nlink!==before.nlink||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||digest!==undefined&&digest!==actual)fail();
        digest=actual;
        temporary=path.join(parent,'.vertex-copy-'+crypto.randomUUID());
        output=fs.openSync(temporary,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
        created=fs.fstatSync(output);
        fs.writeFileSync(output,bytes);
        fs.fchmodSync(output,before.mode&0o777);
        fs.fsyncSync(output);
        const copiedHash=crypto.createHash('sha256'),chunk=Buffer.alloc(Math.min(before.size,1048576));
        let position=0;
        while(position<before.size){const n=fs.readSync(output,chunk,0,Math.min(chunk.length,before.size-position),position);if(n===0)fail();copiedHash.update(chunk.subarray(0,n));position+=n;}
        if(copiedHash.digest('hex')!==actual)fail();
        const copied=fs.fstatSync(output),still=fs.lstatSync(absolute),temp=fs.lstatSync(temporary);
        if(!copied.isFile()||copied.nlink!==1||copied.size!==before.size||(copied.mode&0o777)!==(before.mode&0o777)||copied.uid!==before.uid||copied.gid!==before.gid||copied.dev!==temp.dev||copied.ino!==temp.ino||still.dev!==before.dev||still.ino!==before.ino||still.nlink!==before.nlink||fs.realpathSync(parent)!==parent)fail();
        fs.renameSync(temporary,absolute);
        temporary=undefined;
      }finally{
        fs.closeSync(input);
        if(output!==undefined)fs.closeSync(output);
        // Remove only the uniquely created inode; a substituted path is not ours.
        if(temporary&&created){const own=fs.lstatSync(temporary);if(own.dev===created.dev&&own.ino===created.ino)fs.unlinkSync(temporary);}
      }
    }
  }
}
try {
  const action=process.argv[2];
  if(!['prepare','verify','run'].includes(action)||process.version!=='v22.13.1')fail();
  const bun=spawnSync('/usr/local/bin/bun',['--version'],{encoding:'utf8',env:{PATH:'/usr/local/bin:/usr/bin:/bin'},timeout:10000,maxBuffer:4096});
  if(bun.status!==0||bun.stdout.trim()!=='1.3.14')fail();
  const manifest=JSON.parse(fs.readFileSync('/opt/vertex/source-manifest.json','utf8'));
  const expected=new Map(manifest.files.map(f=>[f.path,f]));
  if(action==='prepare'){
    const require=createRequire(root+'/apps/web/package.json');
    if(!require('esbuild').transformSync('export const isolated = true').code)fail();
    const packages=fs.readdirSync(root+'/node_modules/.pnpm');
    for(const name of ['sharp','workerd']){
      const matches=packages.filter(p=>p.startsWith(name+'@'));
      if(matches.length===0)fail();
      for(const entry of matches){
        const base=root+'/node_modules/.pnpm/'+entry+'/node_modules/'+name;
        if(name==='sharp'){if(!require(base).versions?.vips)fail();}
        else{const result=spawnSync(base+'/bin/workerd',['--version'],{env:{PATH:'/usr/local/bin:/usr/bin:/bin'},encoding:'utf8',timeout:10000,maxBuffer:4096});if(result.status!==0||!result.stdout.includes('workerd'))fail();}
      }
    }
    // esbuild and workerd legitimately link their native package executable to
    // the public bin path. Break only fully accounted in-tree dependency aliases
    // into independent bytes before the unchanged nlink=1 final audit/seal.
    normalizeDependencyHardlinks(expected);
  }
  const seen=new Set(),items=[];
  let count=0,total=0;
  function walk(dir){
    for(const name of fs.readdirSync(dir).sort()){
      if(++count>250000)fail();
      const absolute=path.join(dir,name),rel=path.relative(root,absolute);
      const st=fs.lstatSync(absolute);
      if(outputs.includes(rel)){
        if(!st.isDirectory()||fs.readdirSync(absolute).length!==0)fail();
        continue;
      }
      if(st.isDirectory()){if(st.mode&0o6000)fail();walk(absolute);continue;}
      const source=expected.get(rel),dependency=rel.split('/').includes('node_modules');
      if(!source&&!dependency)fail();
      if(st.isSymbolicLink()){
        const target=fs.readlinkSync(absolute);
        if(source||path.isAbsolute(target)||!within(path.resolve(path.dirname(absolute),target))||!within(fs.realpathSync(absolute)))fail();
        items.push([rel,'link',target]);
      }else{
        if(!st.isFile()||st.nlink!==1||(st.mode&0o6000)||st.size>134217728)fail();
        total+=st.size;if(total>8589934592)fail();
        const digest=hash(fs.readFileSync(absolute));
        if(source){if(source.sha256!==digest||((st.mode&0o111)!==0)!==(source.mode==='100755'))fail();seen.add(rel);}
        else items.push([rel,st.mode&0o777,digest]);
      }
    }
  }
  walk(root);
  if(seen.size!==expected.size)fail();
  for(const [name,version]of Object.entries({'@vinext/cloudflare':'1.0.0-beta.3',vinext:'1.0.0-beta.3','@cloudflare/vite-plugin':'1.47.0',wrangler:'4.114.0',vite:'8.1.5'})){
    const p=root+'/apps/web/node_modules/'+name+'/package.json';
    if(!within(fs.realpathSync(p))||JSON.parse(fs.readFileSync(p,'utf8')).version!==version)fail();
  }
  const dependencySha256=hash(JSON.stringify(items));
  const toolchainSha256=hash(JSON.stringify(['/usr/local/bin/node','/usr/local/bin/bun','/opt/vertex/guard.mjs'].map(p=>[p,hash(fs.readFileSync(p))])));
  const identity={sourceSha256:manifest.sourceSha256,authoritySha256:manifest.authoritySha256,policySha256:manifest.policySha256,dependencySha256,toolchainSha256};
  if(action==='prepare'){
    fs.writeFileSync('/opt/vertex/inputs.json',JSON.stringify(identity),{mode:0o444});
    for(const p of outputs)fs.mkdirSync(root+'/'+p,{recursive:true});
  }else{
    if(JSON.stringify(identity)!==fs.readFileSync('/opt/vertex/inputs.json','utf8'))fail();
    if(action==='verify')process.stdout.write(JSON.stringify(identity));
    else{
      const mode=process.argv[3],environment=process.argv[4];
      if(!['check','deploy'].includes(mode)||!['production','staging'].includes(environment)||process.argv.length!==5)fail();
      const args=['deploy',...(mode==='check'?['--dry-run']:[]),...(environment==='staging'?['--env','staging']:[])];
      const child=spawnSync('/usr/local/bin/node',[root+'/apps/web/node_modules/@vinext/cloudflare/dist/cli.js',...args],{cwd:root+'/apps/web',env:process.env,stdio:['ignore','inherit','inherit'],shell:false});
      process.exitCode=child.status===null?1:child.status;
    }
  }
}catch{process.stderr.write('sealed deployment inputs unavailable\n');process.exitCode=1;}
`;
