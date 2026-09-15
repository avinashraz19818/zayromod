'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');

function setupPrivate(root, signingEnv) {
  const target = path.join(root, '.env');
  const credentials = path.join(root, 'secrets', 'admin-access.txt');
  if (fs.existsSync(target) || fs.existsSync(credentials)) throw Error('Configuration already exists; refusing to overwrite secrets.');
  const values = dotenv.parse(fs.readFileSync(path.join(root, '.env.example')));
  if (signingEnv) {
    const previous = dotenv.parse(fs.readFileSync(signingEnv));
    const keys = ['KEYSTORE_PATH','KEYSTORE_ALIAS','KEYSTORE_PASSWORD','KEY_PASSWORD'];
    for (const key of keys) {
      if (!previous[key]) throw Error(`Signing source is missing ${key}`);
      values[key] = previous[key];
    }
    if (!path.isAbsolute(values.KEYSTORE_PATH) || !fs.statSync(values.KEYSTORE_PATH).isFile()) throw Error('Signing key must be an existing absolute file path.');
  }
  values.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
  values.CONTENT_ENCRYPTION_PASSWORD = crypto.randomBytes(48).toString('hex');
  const password = crypto.randomBytes(24).toString('base64url');
  values.ADMIN_PASSWORD_HASH = bcrypt.hashSync(password, 12);
  values.ADMIN_USERNAME = 'admin';
  fs.mkdirSync(path.dirname(credentials), {recursive:true, mode:0o700});
  // Reserve both files exclusively, with restrictive permissions from creation.
  let envFd, accessFd;
  try {
    envFd = fs.openSync(target, 'wx', 0o600);
    accessFd = fs.openSync(credentials, 'wx', 0o600);
    fs.writeFileSync(accessFd, `MizanMod admin\nUsername: admin\nPassword: ${password}\nKeep this private; never upload or paste it into chat.\n`);
    fs.writeFileSync(envFd, Object.entries(values).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n');
  } finally {
    if (envFd !== undefined) fs.closeSync(envFd);
    if (accessFd !== undefined) fs.closeSync(accessFd);
  }
  return {config:target, credentials, reusedSigningKey:Boolean(signingEnv)};
}
if (require.main === module) {
  try {
    const arg = process.argv.slice(2).find(v=>v.startsWith('--signing-env='));
    const result = setupPrivate(path.resolve(__dirname,'..'),arg?.slice('--signing-env='.length));
    console.log('Private configuration created. No secret values printed.');
    console.log('Admin credentials file: secrets/admin-access.txt (read privately).');
    console.log(result.reusedSigningKey ? 'Existing Mizan signing key preserved; only four signing settings copied.' : 'Signing settings still need configuration.');
    console.log('Set the NEW Firebase and Telegram values in .env, then run npm run doctor.');
  } catch(e) { console.error(e.message);process.exitCode=1; }
}
module.exports={setupPrivate};
