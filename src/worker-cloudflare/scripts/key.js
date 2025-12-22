import { Ed25519KeyIdentity } from '@dfinity/identity';

const id = Ed25519KeyIdentity.generate();
const keyPair = id.getKeyPair();
const sk = keyPair.secretKey;
const principal = id.getPrincipal().toText();
console.log('principal:', principal);
console.log('secret_base64:', Buffer.from(sk).toString('base64'));