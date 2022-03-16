import * as anchor from '@project-serum/anchor';
import { Program } from "@project-serum/anchor";

import { Gominola } from './utils/gominola'

import {
  MintLayout,
  TOKEN_PROGRAM_ID,
  Token,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  PublicKey,
  TransactionInstruction,
  Connection as RPCConnection,
  PublicKey as SolanaPublicKey,
} from '@solana/web3.js';
import { sendTransactions } from './connection';

import { sha256 } from 'js-sha256';

import {
  CIVIC,
  getAtaForMint,
  getNetworkExpire,
  getNetworkToken,
  SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
} from './utils';

// import { GUMDROP_DISTRIBUTOR_ID } from './utils/ids';

import { coder } from './utils/merkleDistributor';
import BN from 'bn.js';
import * as bs58 from 'bs58';
import { walletKeyOrPda } from './utils/walletKeyOrpda';
import { proof as listOfProof } from './utils/proof';

export const CANDY_MACHINE_PROGRAM = new anchor.web3.PublicKey(
  'cndy3Z4yapfJBmL3ShUp5exZKqR3z33thTzeNMm2gRZ',
);

const TOKEN_METADATA_PROGRAM_ID = new anchor.web3.PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);



const GUMDROP_DISTRIBUTOR_ID = new PublicKey(
  'gdrpGjVffourzkdDRrQmySw4aTHr8a3xmQzzxSwFD1a',
);

interface CandyMachineState {
  itemsAvailable: number;
  itemsRedeemed: number;
  itemsRemaining: number;
  treasury: anchor.web3.PublicKey;
  tokenMint: anchor.web3.PublicKey;
  isSoldOut: boolean;
  isActive: boolean;
  isPresale: boolean;
  isWhitelistOnly: boolean;
  goLiveDate: anchor.BN;
  price: anchor.BN;
  gatekeeper: null | {
    expireOnUse: boolean;
    gatekeeperNetwork: anchor.web3.PublicKey;
  };
  endSettings: null | {
    number: anchor.BN;
    endSettingType: any;
  };
  whitelistMintSettings: null | {
    mode: any;
    mint: anchor.web3.PublicKey;
    presale: boolean;
    discountPrice: null | anchor.BN;
  };
  hiddenSettings: null | {
    name: string;
    uri: string;
    hash: Uint8Array;
  };
}

export interface CandyMachineAccount {
  id: anchor.web3.PublicKey;
  program: anchor.Program;
  state: CandyMachineState;
}

export const awaitTransactionSignatureConfirmation = async (
  txid: anchor.web3.TransactionSignature,
  timeout: number,
  connection: anchor.web3.Connection,
  queryStatus = false,
): Promise<anchor.web3.SignatureStatus | null | void> => {
  let done = false;
  let status: anchor.web3.SignatureStatus | null | void = {
    slot: 0,
    confirmations: 0,
    err: null,
  };
  let subId = 0;
  status = await new Promise(async (resolve, reject) => {
    setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      console.log('Rejecting for timeout...');
      reject({ timeout: true });
    }, timeout);

    while (!done && queryStatus) {
      // eslint-disable-next-line no-loop-func
      (async () => {
        try {
          const signatureStatuses = await connection.getSignatureStatuses([
            txid,
          ]);
          status = signatureStatuses && signatureStatuses.value[0];
          if (!done) {
            if (!status) {
              console.log('REST null result for', txid, status);
            } else if (status.err) {
              console.log('REST error for', txid, status);
              done = true;
              reject(status.err);
            } else if (!status.confirmations) {
              console.log('REST no confirmations for', txid, status);
            } else {
              console.log('REST confirmation for', txid, status);
              done = true;
              resolve(status);
            }
          }
        } catch (e) {
          if (!done) {
            console.log('REST connection error: txid', txid, e);
          }
        }
      })();
      await sleep(2000);
    }
  });

  //@ts-ignore
  if (connection._signatureSubscriptions[subId]) {
    connection.removeSignatureListener(subId);
  }
  done = true;
  console.log('Returning status', status);
  return status;
};

const createAssociatedTokenAccountInstruction = (
  associatedTokenAddress: anchor.web3.PublicKey,
  payer: anchor.web3.PublicKey,
  walletAddress: anchor.web3.PublicKey,
  splTokenMintAddress: anchor.web3.PublicKey,
) => {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: associatedTokenAddress, isSigner: false, isWritable: true },
    { pubkey: walletAddress, isSigner: false, isWritable: false },
    { pubkey: splTokenMintAddress, isSigner: false, isWritable: false },
    {
      pubkey: anchor.web3.SystemProgram.programId,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    {
      pubkey: anchor.web3.SYSVAR_RENT_PUBKEY,
      isSigner: false,
      isWritable: false,
    },
  ];
  return new anchor.web3.TransactionInstruction({
    keys,
    programId: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
    data: Buffer.from([]),
  });
};

export const getCandyMachineState = async (
  anchorWallet: anchor.Wallet,
  candyMachineId: anchor.web3.PublicKey,
  connection: anchor.web3.Connection,
): Promise<CandyMachineAccount> => {
  const provider = new anchor.Provider(connection, anchorWallet, {
    preflightCommitment: 'processed',
  });

  const idl = await anchor.Program.fetchIdl(CANDY_MACHINE_PROGRAM, provider);

  const program = new anchor.Program(idl!, CANDY_MACHINE_PROGRAM, provider);

  const state: any = await program.account.candyMachine.fetch(candyMachineId);
  const itemsAvailable = state.data.itemsAvailable.toNumber();
  const itemsRedeemed = state.itemsRedeemed.toNumber();
  const itemsRemaining = itemsAvailable - itemsRedeemed;

  return {
    id: candyMachineId,
    program,
    state: {
      itemsAvailable,
      itemsRedeemed,
      itemsRemaining,
      isSoldOut: itemsRemaining === 0,
      isActive: false,
      isPresale: false,
      isWhitelistOnly: false,
      goLiveDate: state.data.goLiveDate,
      treasury: state.wallet,
      tokenMint: state.tokenMint,
      gatekeeper: state.data.gatekeeper,
      endSettings: state.data.endSettings,
      whitelistMintSettings: state.data.whitelistMintSettings,
      hiddenSettings: state.data.hiddenSettings,
      price: state.data.price,
    },
  };
};

const getMasterEdition = async (
  mint: anchor.web3.PublicKey,
): Promise<anchor.web3.PublicKey> => {
  return (
    await anchor.web3.PublicKey.findProgramAddress(
      [
        Buffer.from('metadata'),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
        Buffer.from('edition'),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    )
  )[0];
};

const getMetadata = async (
  mint: anchor.web3.PublicKey,
): Promise<anchor.web3.PublicKey> => {
  return (
    await anchor.web3.PublicKey.findProgramAddress(
      [
        Buffer.from('metadata'),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    )
  )[0];
};

export const getCandyMachineCreator = async (
  candyMachine: anchor.web3.PublicKey,
): Promise<[anchor.web3.PublicKey, number]> => {
  return await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from('candy_machine'), candyMachine.toBuffer()],
    CANDY_MACHINE_PROGRAM,
  );
};

export const getCollectionPDA = async (
  candyMachineAddress: anchor.web3.PublicKey,
): Promise<[anchor.web3.PublicKey, number]> => {
  return await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from('collection'), candyMachineAddress.toBuffer()],
    CANDY_MACHINE_PROGRAM,
  );
};

export interface CollectionData {
  mint: anchor.web3.PublicKey;
  candyMachine: anchor.web3.PublicKey;
}

export const getCollectionAuthorityRecordPDA = async (
  mint: anchor.web3.PublicKey,
  newAuthority: anchor.web3.PublicKey,
): Promise<anchor.web3.PublicKey> => {
  return (
    await anchor.web3.PublicKey.findProgramAddress(
      [
        Buffer.from('metadata'),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
        Buffer.from('collection_authority'),
        newAuthority.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    )
  )[0];
};

export const mintOneToken = async (
  candyMachine: CandyMachineAccount,
  payer: anchor.web3.PublicKey,
  connection: any,
): Promise<(string | undefined)[]> => {
  const mint = anchor.web3.Keypair.generate();

  const userTokenAccountAddress = (
    await getAtaForMint(mint.publicKey, payer)
  )[0];

  const userPayingAccountAddress = candyMachine.state.tokenMint
    ? (await getAtaForMint(candyMachine.state.tokenMint, payer))[0]
    : payer;

  const candyMachineAddress = candyMachine.id;
  const remainingAccounts = [];
  const signers: anchor.web3.Keypair[] = [mint];
  const cleanupInstructions = [];
  // start veru

  const tokenAccKey = new PublicKey(
    '7iFHzyW6twPrGoSyuJ2BzYePtpfThxRT6JDeJcF8s1E8',
  ); // source ata whitelist token
  const mintwl = new PublicKey('nftmF6vKrWdGwvmnZ6zt1sMj4UHUUBfRVksxyGib8Wn'); // mint WL

  const userWhitelistTokenAccountAddress = (
    await getAtaForMint(mintwl, payer)
  )[0];

  console.log(mintwl.toBase58());

  // TODO: since it's in the PDA do we need it to be in the leaf?
  // const leaf = Buffer.from([
  //   ...new BN(index).toArray('le', 8),
  //   ...walletKey.toBuffer(),
  //   ...mintwl.toBuffer(),
  //   ...new BN(amount).toArray('le', 8),
  // ]);

  // const matches = MerkleTree.verifyClaim(
  //   leaf,
  //   proof,
  //   Buffer.from(distributorInfo.root),
  // );

  // if (!matches) {
  //   throw new Error('Gumdrop merkle proof does not match');
  // }

  // const [claimStatus, cbump] = await PublicKey.findProgramAddress(
  //   [
  //     Buffer.from('ClaimStatus'),
  //     Buffer.from(new BN(index).toArray('le', 8)),
  //     distributorKey.toBuffer(),
  //   ],
  //   GUMDROP_DISTRIBUTOR_ID,
  // );

  const [walletTokenKey] = await PublicKey.findProgramAddress(
    [payer.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintwl.toBuffer()],
    SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
  );
  console.log('351');

  const accountInfo =
    await candyMachine.program.provider.connection.getParsedAccountInfo(
      walletTokenKey,
    );
  console.log('354');

  const isAccountInfoExist = accountInfo?.value !== null;
  console.log('357');

  const createATA = (mintwl: PublicKey, payer: PublicKey) => {
    return Token.createAssociatedTokenAccountInstruction(
      SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      mintwl,
      walletTokenKey,
      payer,
      payer,
    );
  };
  console.log('370');

  const walletKey = payer;
  console.log('373');
  const handle = payer.toString();
  console.log('375');
  const pin: BN | null = null;
  // const pin = new BN('NA');

  console.log('375');
  const chunk = (arr: Buffer, len: number): Array<Buffer> => {
    const chunks: Array<Buffer> = [];
    const n = arr.length;
    let i = 0;

    while (i < n) {
      chunks.push(arr.slice(i, (i += len)));
    }

    return chunks;
  };

  console.log('375');

  // const [secret, pdaSeeds] = await walletKeyOrPda(walletKey, handle, pin, mintwl);

  const pdaSeeds = [];

  console.log('397');

  const secret = walletKey;

  console.log('ligne 375');

  // const secret: PublicKey = new SolanaPublicKey(walletTokenKey.toString());
  // const pdaSeeds = []
  const fetchDistributor = async (
    connection: RPCConnection,
    distributorStr: string,
  ) => {
    let key;
    try {
      key = new SolanaPublicKey(distributorStr);
    } catch (err) {
      throw new Error(`Invalid distributor key ${err}`);
    }
    const account = await connection.getAccountInfo(key);
    if (account === null) {
      throw new Error(`Could not fetch distributor ${distributorStr}`);
    }
    if (!account.owner.equals(GUMDROP_DISTRIBUTOR_ID)) {
      const ownerStr = account.owner.toBase58();
      throw new Error(`Invalid distributor owner ${ownerStr}`);
    }
    const info = coder.accounts.decode('MerkleDistributor', account.data);
    return [key, info];
  };

  // PAS COOL A  REFAIRE
  const distributor = '62hzURvLFSKt5hKmsvjvGMWveWK57D6HtrQ6SLwTXbSU';

  const [distributorKey, distributorInfo] = await fetchDistributor(
    connection,
    distributor,
  );

  console.log('ligne 410');
  // PAS COOL A  REFAIRE
  const index = 0;
  const amount = 1;
  const [claimStatus, cbump] = await PublicKey.findProgramAddress(
    [
      Buffer.from('ClaimStatus'),
      Buffer.from(new BN(index).toArray('le', 8)),
      distributorKey.toBuffer(),
    ],
    GUMDROP_DISTRIBUTOR_ID,
  );

  const temporalSigner =
    distributorInfo.temporal.equals(PublicKey.default) ||
      secret.equals(walletKey)
      ? walletKey
      : distributorInfo.temporal;

  const walletString = walletKey.toString();

  const proofStr = listOfProof.find(e => e.key === walletString);

  const proof =
    proofStr === undefined
      ? []
      : proofStr.proof.map((b: string) => {
        const ret = Buffer.from(bs58.decode(b));
        if (ret.length !== 32) throw new Error(`Invalid proof hash length`);
        return ret;
      });

  // let trx = await program.rpc.getToken(
  //   new anchor.BN(1),
  //   {
  //     accounts: {
  //       payer: buyer.publicKey,
  //       payerAta: buyer_ata.address,
  //       vaultAta: vault_ata,
  //       whitelistPda: whitelist_pda,
  //       vaultAuthority: vault_authority,
  //       systemProgram: anchor.web3.SystemProgram.programId,
  //       tokenProgram: TOKEN_PROGRAM_ID,
  //     },
  //     signers: [buyer],
  //   });


  // const claimAirdrop = () => {
  // let trx = await program.rpc.getToken(new anchor.BN(1), {
  //   accounts: {
  //     payer: buyer.publicKey,
  //     payerAta: buyer_ata.address,
  //     vaultAta: vault_ata,
  //     whitelistPda: whitelist_pda,
  //     vaultAuthority: vault_authority,
  //     systemProgram: anchor.web3.SystemProgram.programId,
  //     tokenProgram: TOKEN_PROGRAM_ID,
  //   },
  //   signers: [buyer],
  // });
  // "3rFPLdQ6tdJPR32QxAWc82LTcNmHWWQTkBLu6HJbuXBQ"
  //   return new TransactionInstruction({
  //   programId: GUMDROP_DISTRIBUTOR_ID,
  //   keys: [
  //     { pubkey: distributorKey, isSigner: false, isWritable: true },
  //     { pubkey: claimStatus, isSigner: false, isWritable: true },
  //     { pubkey: tokenAccKey, isSigner: false, isWritable: true },
  //     { pubkey: walletTokenKey, isSigner: false, isWritable: true },
  //     { pubkey: temporalSigner, isSigner: true, isWritable: false },
  //     { pubkey: walletKey, isSigner: true, isWritable: false }, // payer
  //     { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  //     { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  //   ],
  //   data: Buffer.from([
  //     ...Buffer.from(sha256.digest('global:claim')).slice(0, 8),
  //     ...new BN(cbump).toArray('le', 1),
  //     ...new BN(index).toArray('le', 8),
  //     ...new BN(amount).toArray('le', 8),
  //     ...secret.toBuffer(),
  //     ...new BN(proof.length).toArray('le', 4),
  //     ...Buffer.concat(proof),
  //   ]),
  // })
  // };
  // end veru

  const programId = new PublicKey("3rFPLdQ6tdJPR32QxAWc82LTcNmHWWQTkBLu6HJbuXBQ");

  const [whitelist_pda, _whitelist_pda_bump] = await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from('WhiteList'), payer.toBuffer()],
    programId
  );

  const [vault_authority, _vault_authority_bump] = await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from('vault_authority')],
    programId
  );

  const [vault_ata, _vault_ata_bump] = await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from('vault_ata'), mintwl.toBuffer()],
    programId
  );

  console.log('shasha', ...Buffer.from(sha256.digest('global:get_token')).slice(0, 8))
  console.log('ligne 530');
  console.log('payer    :', payer.toString());
  console.log('walletTokenKey    :', walletTokenKey.toString());
  console.log('vault_ata    :', vault_ata.toString());
  console.log('whitelist_pda    :', whitelist_pda.toString());
  console.log('vault_authority    :', vault_authority.toString());
  console.log('isAccountInfoExist    :', isAccountInfoExist);

  //const program = anchor.workspace.Gominola as anchor.Program<Gominola>;

  const program = anchor.workspace.Gominola

  console.log(new TransactionInstruction({

    programId: new PublicKey("3rFPLdQ6tdJPR32QxAWc82LTcNmHWWQTkBLu6HJbuXBQ"),
    keys: [
      // Payer
      { pubkey: payer, isSigner: true, isWritable: true },
      // payer ata
      { pubkey: walletTokenKey, isSigner: false, isWritable: true },
      //vaultAta
      { pubkey: vault_ata, isSigner: false, isWritable: true },
      //whitelistPda
      { pubkey: whitelist_pda, isSigner: false, isWritable: true },
      //vaultAuthority
      { pubkey: vault_authority, isSigner: false, isWritable: true },
      //systemProgram
      { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      //tokenProgram
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },

    ],
    data: Buffer.from([
      ...Buffer.from(sha256.digest('global:get_token')).slice(0, 8),
      ...new BN(1).toArray('le', 8),
    ]),

  }))

  const instructions = [
    // add gumdrop here
    // claimAirdrop(),
    new TransactionInstruction({

      programId: new PublicKey("3rFPLdQ6tdJPR32QxAWc82LTcNmHWWQTkBLu6HJbuXBQ"),
      keys: [
        // Payer
        { pubkey: payer, isSigner: true, isWritable: true },
        // payer ata
        { pubkey: walletTokenKey, isSigner: false, isWritable: true },
        //vaultAta
        { pubkey: vault_ata, isSigner: false, isWritable: true },
        //whitelistPda
        { pubkey: whitelist_pda, isSigner: false, isWritable: true },
        //vaultAuthority
        { pubkey: vault_authority, isSigner: false, isWritable: true },
        //systemProgram
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
        //tokenProgram
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },

      ],
      data: Buffer.from([
        ...Buffer.from(sha256.digest('global:get_token')).slice(0, 8),
        ...new BN(1).toArray('le', 8),
      ]),

    }),

    // new anchor.BN(1),
    // programId: TOKEN_PROGRAM_ID,
    // {
    //   accounts: {
    //     payer: buyer.publicKey,
    //     payerAta: buyer_ata.address,
    //     vaultAta: vault_ata,
    //     whitelistPda: whitelist_pda,          
    //     vaultAuthority: vault_authority,
    //     systemProgram: anchor.web3.SystemProgram.programId,
    //     tokenProgram: TOKEN_PROGRAM_ID,
    //   },
    //   signers: [buyer],
    // }),
    // end gumdrop


    
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint.publicKey,
      space: MintLayout.span,
      lamports:
        await candyMachine.program.provider.connection.getMinimumBalanceForRentExemption(
          MintLayout.span,
        ),
      programId: TOKEN_PROGRAM_ID,
    }),
    Token.createInitMintInstruction(
      TOKEN_PROGRAM_ID,
      mint.publicKey,
      0,
      payer,
      payer,
    ),
    createAssociatedTokenAccountInstruction(
      userTokenAccountAddress,
      payer,
      payer,
      mint.publicKey,
    ),
    Token.createMintToInstruction(
      TOKEN_PROGRAM_ID,
      mint.publicKey,
      userTokenAccountAddress,
      payer,

      [],
      1,
    ),
  ];


  if (candyMachine.state.gatekeeper) {
    remainingAccounts.push({
      pubkey: (
        await getNetworkToken(
          payer,
          candyMachine.state.gatekeeper.gatekeeperNetwork,
        )
      )[0],
      isWritable: true,
      isSigner: false,
    });
    if (candyMachine.state.gatekeeper.expireOnUse) {
      remainingAccounts.push({
        pubkey: CIVIC,
        isWritable: false,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: (
          await getNetworkExpire(
            candyMachine.state.gatekeeper.gatekeeperNetwork,
          )
        )[0],
        isWritable: false,
        isSigner: false,
      });
    }
  }
  if (candyMachine.state.whitelistMintSettings) {
    const mint = new anchor.web3.PublicKey(
      candyMachine.state.whitelistMintSettings.mint,
    );

    const whitelistToken = (await getAtaForMint(mint, payer))[0];
    remainingAccounts.push({
      pubkey: whitelistToken,
      isWritable: true,
      isSigner: false,
    });

    if (candyMachine.state.whitelistMintSettings.mode.burnEveryTime) {
      const whitelistBurnAuthority = anchor.web3.Keypair.generate();

      remainingAccounts.push({
        pubkey: mint,
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: whitelistBurnAuthority.publicKey,
        isWritable: false,
        isSigner: true,
      });
      signers.push(whitelistBurnAuthority);
      const exists =
        await candyMachine.program.provider.connection.getAccountInfo(
          whitelistToken,
        );
      if (exists) {
        instructions.push(
          Token.createApproveInstruction(
            TOKEN_PROGRAM_ID,
            whitelistToken,
            whitelistBurnAuthority.publicKey,
            payer,
            [],
            1,
          ),
        );
        cleanupInstructions.push(
          Token.createRevokeInstruction(
            TOKEN_PROGRAM_ID,
            whitelistToken,
            payer,
            [],
          ),
        );
      }
    }
  }

  if (candyMachine.state.tokenMint) {
    const transferAuthority = anchor.web3.Keypair.generate();

    signers.push(transferAuthority);
    remainingAccounts.push({
      pubkey: userPayingAccountAddress,
      isWritable: true,
      isSigner: false,
    });
    remainingAccounts.push({
      pubkey: transferAuthority.publicKey,
      isWritable: false,
      isSigner: true,
    });

    instructions.push(
      Token.createApproveInstruction(
        TOKEN_PROGRAM_ID,
        userPayingAccountAddress,
        transferAuthority.publicKey,
        payer,
        [],
        candyMachine.state.price.toNumber(),
      ),
    );
    cleanupInstructions.push(
      Token.createRevokeInstruction(
        TOKEN_PROGRAM_ID,
        userPayingAccountAddress,
        payer,
        [],
      ),
    );
  }
  const metadataAddress = await getMetadata(mint.publicKey);
  const masterEdition = await getMasterEdition(mint.publicKey);

  const [collectionPDA] = await getCollectionPDA(candyMachineAddress);
  const collectionPDAAccount =
    await candyMachine.program.provider.connection.getAccountInfo(
      collectionPDA,
    );
  if (collectionPDAAccount) {
    try {
      const collectionData =
        (await candyMachine.program.account.collectionPda.fetch(
          collectionPDA,
        )) as CollectionData;
      console.log(collectionData);
      const collectionMint = collectionData.mint;
      const collectionAuthorityRecord = await getCollectionAuthorityRecordPDA(
        collectionMint,
        collectionPDA,
      );
      console.log(collectionMint);
      if (collectionMint) {
        const collectionMetadata = await getMetadata(collectionMint);
        const collectionMasterEdition = await getMasterEdition(collectionMint);
        remainingAccounts.push(
          ...[
            {
              pubkey: collectionPDA,
              isWritable: true,
              isSigner: false,
            },
            {
              pubkey: collectionMint,
              isWritable: false,
              isSigner: false,
            },
            {
              pubkey: collectionMetadata,
              isWritable: true,
              isSigner: false,
            },
            {
              pubkey: collectionMasterEdition,
              isWritable: false,
              isSigner: false,
            },
            {
              pubkey: collectionAuthorityRecord,
              isWritable: false,
              isSigner: false,
            },
          ],
        );
      }
    } catch (error) {
      console.error(error);
    }
  }

  const [candyMachineCreator, creatorBump] = await getCandyMachineCreator(
    candyMachineAddress,
  );

  instructions.push(
    await candyMachine.program.instruction.mintNft(creatorBump, {
      accounts: {
        candyMachine: candyMachineAddress,
        candyMachineCreator,
        payer: payer,
        wallet: candyMachine.state.treasury,
        mint: mint.publicKey,
        metadata: metadataAddress,
        masterEdition,
        mintAuthority: payer,
        updateAuthority: payer,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        recentBlockhashes: SYSVAR_SLOT_HASHES_PUBKEY,
        instructionSysvarAccount: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      },
      remainingAccounts:
        remainingAccounts.length > 0 ? remainingAccounts : undefined,
    }),
  );

  try {
    return (
      await sendTransactions(
        candyMachine.program.provider.connection,
        candyMachine.program.provider.wallet,
        [instructions, cleanupInstructions],
        [signers, []],
      )
    ).txs.map(t => t.txid);
  } catch (e) {
    console.log(e);
  }

  return [];
};

export const shortenAddress = (address: string, chars = 4): string => {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
};

const sleep = (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};
