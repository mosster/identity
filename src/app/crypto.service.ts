import { Injectable } from '@angular/core';
import * as bip39 from 'bip39';
import bs58check from 'bs58check';
import {
  createCipher,
  createDecipher,
  createHash,
  createHmac,
  randomBytes,
} from 'crypto';
import { ec as EC } from 'elliptic';
import { default as HDKey, default as HDNode } from 'hdkey';
import { CookieService } from 'ngx-cookie';
import * as sha256 from 'sha256';
import { Keccak } from 'sha3';
import { AccessLevel, Network } from '../types/identity';
import { GlobalVarsService } from './global-vars.service';

@Injectable({
  providedIn: 'root',
})
export class CryptoService {
  constructor(
    private cookieService: CookieService,
    private globalVars: GlobalVarsService
  ) {}

  static PUBLIC_KEY_PREFIXES = {
    mainnet: {
      bitcoin: [0x00],
      deso: [0xcd, 0x14, 0x0],
    },
    testnet: {
      bitcoin: [0x6f],
      deso: [0x11, 0xc2, 0x0],
    },
  };

  // Safari only lets us store things in cookies
  mustUseStorageAccess(): boolean {
    // Webviews have full control over storage access
    if (this.globalVars.webview) {
      return false;
    }

    const supportsStorageAccess =
      typeof document.hasStorageAccess === 'function';
    const isChrome = navigator.userAgent.indexOf('Chrome') > -1;
    const isSafari = !isChrome && navigator.userAgent.indexOf('Safari') > -1;

    // Firefox and Edge support the storage access API but do not enforce it.
    // For now, only use cookies if we support storage access and use Safari.
    const mustUseStorageAccess = supportsStorageAccess && isSafari;

    return mustUseStorageAccess;
  }

  // 32 bytes = 256 bits is plenty of entropy for encryption
  newEncryptionKey(): string {
    return randomBytes(32).toString('hex');
  }

  seedHexEncryptionStorageKey(hostname: string): string {
    return `seed-hex-key-${hostname}`;
  }

  hasSeedHexEncryptionKey(hostname: string): boolean {
    const storageKey = this.seedHexEncryptionStorageKey(hostname);

    if (this.mustUseStorageAccess()) {
      return !!this.cookieService.get(storageKey);
    } else {
      return !!localStorage.getItem(storageKey);
    }
  }

  // Place a seed encryption key in storage. If reset is set to true, the
  // previous key is overwritten, which is useful in logging out users.
  seedHexEncryptionKey(hostname: string, reset: boolean = false): string {
    const storageKey = this.seedHexEncryptionStorageKey(hostname);
    let encryptionKey;

    if (this.mustUseStorageAccess()) {
      encryptionKey = this.cookieService.get(storageKey);
      if (!encryptionKey || reset) {
        encryptionKey = this.newEncryptionKey();
        this.cookieService.put(storageKey, encryptionKey, {
          expires: new Date('2100/01/01 00:00:00'),
        });
      }
    } else {
      encryptionKey = localStorage.getItem(storageKey) || '';
      if (!encryptionKey || reset) {
        encryptionKey = this.newEncryptionKey();
        localStorage.setItem(storageKey, encryptionKey);
      }
    }

    // If the encryption key is unset or malformed we need to stop
    // everything to avoid returning unencrypted information.
    if (!encryptionKey || encryptionKey.length !== 64) {
      throw new Error(
        'Failed to load or generate encryption key; this should never happen'
      );
    }

    return encryptionKey;
  }

  encryptSeedHex(seedHex: string, hostname: string): string {
    const encryptionKey = this.seedHexEncryptionKey(hostname, false);
    const cipher = createCipher('aes-256-gcm', encryptionKey);
    return cipher.update(seedHex).toString('hex');
  }

  decryptSeedHex(encryptedSeedHex: string, hostname: string): string {
    const encryptionKey = this.seedHexEncryptionKey(hostname, false);
    const decipher = createDecipher('aes-256-gcm', encryptionKey);
    return decipher.update(Buffer.from(encryptedSeedHex, 'hex')).toString();
  }

  accessLevelHmac(accessLevel: AccessLevel, seedHex: string): string {
    const hmac = createHmac('sha256', seedHex);
    return hmac.update(accessLevel.toString()).digest().toString('hex');
  }

  validAccessLevelHmac(
    accessLevel: AccessLevel,
    seedHex: string,
    hmac: string
  ): boolean {
    if (!hmac || !seedHex) {
      return false;
    }

    return hmac === this.accessLevelHmac(accessLevel, seedHex);
  }

  mnemonicToKeychain(
    mnemonic: string,
    extraText?: string,
    nonStandard?: boolean
  ): HDNode {
    const seed = bip39.mnemonicToSeedSync(mnemonic, extraText);
    // @ts-ignore
    return HDKey.fromMasterSeed(seed).derive("m/44'/0'/0'/0/0", nonStandard);
  }

  keychainToSeedHex(keychain: HDNode): string {
    return keychain.privateKey.toString('hex');
  }

  seedHexToPrivateKey(seedHex: string): EC.KeyPair {
    const ec = new EC('secp256k1');
    return ec.keyFromPrivate(seedHex);
  }

  encryptedSeedHexToPublicKey(encryptedSeedHex: string): string {
    const seedHex = this.decryptSeedHex(
      encryptedSeedHex,
      this.globalVars.hostname
    );
    const privateKey = this.seedHexToPrivateKey(seedHex);
    return this.privateKeyToDeSoPublicKey(privateKey, this.globalVars.network);
  }

  privateKeyToDeSoPublicKey(privateKey: EC.KeyPair, network: Network): string {
    const prefix = CryptoService.PUBLIC_KEY_PREFIXES[network].deso;
    const key = privateKey.getPublic().encode('array', true);
    const prefixAndKey = Uint8Array.from([...prefix, ...key]);

    return bs58check.encode(prefixAndKey);
  }

  publicKeyToDeSoPublicKey(publicKey: EC.KeyPair, network: Network): string {
    const prefix = CryptoService.PUBLIC_KEY_PREFIXES[network].deso;
    const key = publicKey.getPublic().encode('array', true);
    return bs58check.encode(Buffer.from([...prefix, ...key]));
  }

  publicKeyHexToDeSoPublicKey(publicKeyHex: string, network: Network): string {
    const ec = new EC('secp256k1');
    const publicKey = ec.keyFromPublic(publicKeyHex, 'hex');
    return this.publicKeyToDeSoPublicKey(publicKey, network);
  }

  publicKeyToECKeyPair(publicKey: string): EC.KeyPair {
    // Sanity check similar to Base58CheckDecodePrefix from core/lib/base58.go
    if (publicKey.length < 5) {
      throw new Error('Failed to decode public key');
    }
    const decoded = bs58check.decode(publicKey);
    const payload = Uint8Array.from(decoded).slice(3);

    const ec = new EC('secp256k1');
    return ec.keyFromPublic(payload, 'array');
  }

  // Decode public key base58check to Buffer of secp256k1 public key
  publicKeyToECBuffer(publicKey: string): Buffer {
    const publicKeyEC = this.publicKeyToECKeyPair(publicKey);

    return new Buffer(publicKeyEC.getPublic('array'));
  }

  // Decode public key base58check to Buffer of secp256k1 public key
  publicKeyToBuffer(publicKey: string): number[] {
    const publicKeyEC = this.publicKeyToECKeyPair(publicKey);

    return publicKeyEC.getPublic().encode('array', true);
  }

  keychainToBtcAddress(identifier: Buffer, network: Network): string {
    const prefix = CryptoService.PUBLIC_KEY_PREFIXES[network].bitcoin;
    const prefixAndKey = Uint8Array.from([...prefix, ...identifier]);

    return bs58check.encode(prefixAndKey);
  }

  // Taken from https://github.com/cryptocoinjs/hdkey/blob/62c25cc655c9b554b3f9169d69809893408a877d/lib/hdkey.js#L39
  // to compute the HDKey.identifier.
  hash160(buf: Buffer): Buffer {
    const sha = createHash('sha256').update(buf).digest();
    return createHash('ripemd160').update(sha).digest();
  }

  publicKeyToBtcAddress(publicKey: Buffer, network: Network): string {
    const prefix = CryptoService.PUBLIC_KEY_PREFIXES[network].bitcoin;
    const identifier = this.hash160(publicKey);
    const prefixAndKey = Uint8Array.from([...prefix, ...identifier]);

    return bs58check.encode(prefixAndKey);
  }

  // Compute messaging private key as sha256x2( sha256x2(seed hex) || sha256x2(key name) )
  deriveMessagingKey(seedHex: string, keyName: string): Buffer {
    const secretHash = new Buffer(
      sha256.x2([...new Buffer(seedHex, 'hex')]),
      'hex'
    );
    const keyNameHash = new Buffer(
      sha256.x2([...new Buffer(keyName, 'utf8')]),
      'hex'
    );
    return new Buffer(sha256.x2([...secretHash, ...keyNameHash]), 'hex');
  }

  // NOTE: Our ETH address uses the bitcoin/bitclout derivation path, not the ETH path.
  // This is ugly but we only do it because they're just deposit addresses and we couldn't
  // backfill this data for existing users because we store the derived private key.
  // A user can still easily import their account to an ETH client to recover any ETH
  // by coping the seedHex from local storage.
  //
  // We aren't using ethereumjs-util to minimize bundle size and protect from vulnerabilities
  // until LavaMoat is ready
  //
  // Reference implementation: https://github.com/ethereumjs/ethereumjs-util/blob/master/src/account.ts#L249
  publicKeyToEthAddress(keyPair: EC.KeyPair): string {
    const uncompressedKey = Buffer.from(
      keyPair.getPublic(false, 'array').slice(1)
    );
    const ethAddress = new Keccak(256)
      .update(uncompressedKey)
      .digest('hex')
      .slice(24);

    // EIP-55 requires a checksum. Reference implementation: https://eips.ethereum.org/EIPS/eip-55
    const checksumHash = new Keccak(256).update(ethAddress).digest('hex');
    let ethAddressChecksum = '0x';

    for (let i = 0; i < ethAddress.length; i++) {
      if (parseInt(checksumHash[i], 16) >= 8) {
        ethAddressChecksum += ethAddress[i].toUpperCase();
      } else {
        ethAddressChecksum += ethAddress[i];
      }
    }

    return ethAddressChecksum;
  }
}
