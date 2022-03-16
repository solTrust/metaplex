import {
    PublicKey,
  } from '@solana/web3.js';
  import BN from 'bn.js';

  export const GUMDROP_DISTRIBUTOR_ID = new PublicKey(
    'gdrpGjVffourzkdDRrQmySw4aTHr8a3xmQzzxSwFD1a',
  );

export const walletKeyOrPda = async (
    walletKey: PublicKey,
    handle: string,
    pin: BN | null,
    seed: PublicKey,
  ): Promise<[any, Array<Buffer>]> => {
    if (pin === null) {
      try {
        const key = new PublicKey(handle);
        if (!key.equals(walletKey)) {
          throw new Error(
            'Claimant wallet handle does not match connected wallet',
          );
        }
        return [key, []];
      } catch (err) {
        throw new Error(`Invalid claimant wallet handle ${err}`);
      }
    } else {
      const seeds = [
        seed.toBuffer(),
        Buffer.from(handle),
        Buffer.from(pin.toArray('le', 4)),
      ];
  
      const [claimantPda] = await PublicKey.findProgramAddress(
        [seeds[0], ...chunk(seeds[1], 32), seeds[2]],
        GUMDROP_DISTRIBUTOR_ID,
      );
      return [claimantPda, seeds];
    }
  };



  export const chunk = (arr: Buffer, len: number): Array<Buffer> => {
  const chunks: Array<Buffer> = [];
  const n = arr.length;
  let i = 0;

  while (i < n) {
    chunks.push(arr.slice(i, (i += len)));
  }

  return chunks;
};