'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('signing stage resolves SDK tools without relying on service PATH',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../utils/apkbuilder.js'),'utf8');
  const signing=source.indexOf("log('Signing with keystore...');");
  const start=source.lastIndexOf('    if (fs.existsSync(keystorePath)) {',signing);
  const end=source.indexOf('\n    }\n',signing)+7;
  assert.ok(start>=0&&end>start);
  const calls=[],removed=[];
  const env={PATH:'/usr/bin',KEYSTORE_PASSWORD:'synthetic',KEY_PASSWORD:'synthetic'};
  vm.runInNewContext(source.slice(start,end),{
    path,ANDROID_HOME:'/opt/test-sdk',buildDir:'/tmp/synthetic-build',buildId:'test',builtApk:'/tmp/unsigned.apk',signedApk:'/tmp/signed.apk',keystorePath:'/tmp/synthetic.p12',KEYSTORE_ALIAS:'synthetic',buildEnv:env,
    fs:{existsSync:()=>true,unlinkSync:p=>removed.push(p)},log:()=>{},
    execFileSync:(tool,args,options)=>calls.push({tool,args,options})
  });
  assert.equal(calls[0].tool,'/opt/test-sdk/build-tools/35.0.0/zipalign');
  assert.equal(calls[1].tool,'/opt/test-sdk/build-tools/35.0.0/apksigner');
  for(const call of calls)assert.equal(call.options.env,env);
  assert.ok(calls[1].args.includes('env:KEYSTORE_PASSWORD'));
  assert.ok(calls[1].args.includes('env:KEY_PASSWORD'));
  assert.equal(removed.length,1);
});
