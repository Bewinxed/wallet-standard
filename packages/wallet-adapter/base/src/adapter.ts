import {
    BaseWalletAdapter,
    isVersionedTransaction,
    type SendTransactionConfig,
    type StandardWalletAdapter as StandardWalletAdapterType,
    type SupportedTransactionVersions,
    TransactionMessageWithLifetime,
    WalletAccountError,
    type WalletAdapterCompatibleStandardWallet,
    WalletConfigError,
    WalletConnectionError,
    WalletDisconnectedError,
    WalletDisconnectionError,
    WalletError,
    type WalletName,
    WalletNotConnectedError,
    WalletNotReadyError,
    WalletPublicKeyError,
    WalletReadyState,
    WalletSendTransactionError,
    WalletSignInError,
    WalletSignMessageError,
    WalletSignTransactionError,
} from '@bewinxed/wallet-adapter-base';

import {
    SolanaSignAndSendTransaction,
    type SolanaSignAndSendTransactionFeature,
    SolanaSignIn,
    type SolanaSignInInput,
    type SolanaSignInOutput,
    SolanaSignMessage,
    SolanaSignTransaction,
    type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features';
import { getChainForEndpoint, getCommitment } from '@bewinxed/wallet-standard-util';
import type {
    Base64EncodedWireTransaction,
    CompilableTransactionMessage,
    ITransactionMessageWithFeePayer,
    Rpc,
    Signature,
    SolanaRpcApi,
    TransactionBlockhashLifetime,
    TransactionDurableNonceLifetime,
} from '@solana/web3.js';
import {
    Address,
    address as createAddress,
    Transaction,
    BaseTransactionMessage,
    compileTransaction,
    pipe,
    signTransaction,
    getBase64EncodedWireTransaction,
    partiallySignTransaction,
    signature,
    getTransactionDecoder,
    getBase64Encoder,
    decodeTransactionMessage,
    getCompiledTransactionMessageEncoder,
    getCompiledTransactionMessageDecoder,
    decompileTransactionMessage,
} from '@solana/web3.js';
import type { WalletAccount } from '@wallet-standard/base';
import {
    StandardConnect,
    type StandardConnectInput,
    StandardDisconnect,
    StandardEvents,
    type StandardEventsListeners,
} from '@wallet-standard/features';
import { arraysEqual } from '@wallet-standard/wallet';
import bs58 from 'bs58';

/** TODO: docs */
export interface StandardWalletAdapterConfig {
    wallet: WalletAdapterCompatibleStandardWallet;
}

function uint8ArrayTransactionToBase64(transaction: Uint8Array): Base64EncodedWireTransaction {
    // Step 1: Decode the Uint8Array into a transaction object
    const transactionDecoder = getTransactionDecoder();
    const decodedTransaction = transactionDecoder.decode(transaction);

    // Step 2: Get the base64 encoded wire transaction
    return getBase64EncodedWireTransaction(decodedTransaction);
}

/** TODO: docs */
export class StandardWalletAdapter extends BaseWalletAdapter implements StandardWalletAdapterType {
    #account: WalletAccount | null;
    #address: Address | null;
    #connecting: boolean;
    #disconnecting: boolean;
    #endpoint: string | undefined;
    #off: (() => void) | null;
    #supportedTransactionVersions: SupportedTransactionVersions;
    readonly #wallet: WalletAdapterCompatibleStandardWallet;
    readonly #readyState: WalletReadyState =
        typeof window === 'undefined' || typeof document === 'undefined'
            ? WalletReadyState.Unsupported
            : WalletReadyState.Installed;

    get name() {
        return this.#wallet.name as WalletName;
    }

    get url() {
        return 'https://github.com/solana-labs/wallet-standard';
    }

    get icon() {
        return this.#wallet.icon;
    }

    get readyState() {
        return this.#readyState;
    }

    get address() {
        return this.#address;
    }

    get endpoint() {
        return this.#endpoint || 'https://api.mainnet-beta.solana.com';
    }

    get connecting() {
        return this.#connecting;
    }

    get supportedTransactionVersions() {
        return this.#supportedTransactionVersions;
    }

    get wallet(): WalletAdapterCompatibleStandardWallet {
        return this.#wallet;
    }

    get standard() {
        return true as const;
    }

    constructor({ wallet }: StandardWalletAdapterConfig) {
        super();

        this.#wallet = wallet;
        this.#account = null;
        this.#address = null;
        this.#endpoint = undefined;
        this.#connecting = false;
        this.#disconnecting = false;
        this.#off = this.#wallet.features[StandardEvents].on('change', this.#changed);

        this.#reset();
    }

    destroy(): void {
        this.#account = null;
        this.#address = null;
        this.#endpoint = undefined;
        this.#connecting = false;
        this.#disconnecting = false;

        const off = this.#off;
        if (off) {
            this.#off = null;
            off();
        }
    }

    async autoConnect(): Promise<void> {
        return this.#connect({ silent: true });
    }

    async connect(): Promise<void> {
        return this.#connect();
    }

    async #connect(input?: StandardConnectInput): Promise<void> {
        try {
            if (this.connected || this.connecting) return;
            if (this.#readyState !== WalletReadyState.Installed) throw new WalletNotReadyError();

            this.#connecting = true;

            if (!this.#wallet.accounts.length) {
                try {
                    await this.#wallet.features[StandardConnect].connect(input);
                } catch (error: any) {
                    throw new WalletConnectionError(error?.message, error);
                }
            }

            const account = this.#wallet.accounts[0];
            if (!account) throw new WalletAccountError();

            this.#connected(account);
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        } finally {
            this.#connecting = false;
        }
    }

    async disconnect(): Promise<void> {
        if (StandardDisconnect in this.#wallet.features) {
            try {
                this.#disconnecting = true;
                await this.#wallet.features[StandardDisconnect].disconnect();
            } catch (error: any) {
                this.emit('error', new WalletDisconnectionError(error?.message, error));
            } finally {
                this.#disconnecting = false;
            }
        }

        this.#disconnected();
    }

    #connected(account: WalletAccount) {
        let address: Address;
        try {
            // Use account.address instead of account.publicKey since address could be a PDA
            address = createAddress(account.address);
        } catch (error: any) {
            throw new WalletPublicKeyError(error?.message, error);
        }

        this.#account = account;
        this.#address = address;
        this.#reset();
        this.emit('connect', address);
    }

    #disconnected(): void {
        this.#account = null;
        this.#address = null;
        this.#reset();
        this.emit('disconnect');
    }

    #reset() {
        const supportedTransactionVersions =
            SolanaSignAndSendTransaction in this.#wallet.features
                ? this.#wallet.features[SolanaSignAndSendTransaction].supportedTransactionVersions
                : this.#wallet.features[SolanaSignTransaction].supportedTransactionVersions;
        this.#supportedTransactionVersions = arraysEqual(supportedTransactionVersions, ['legacy'])
            ? null
            : new Set(supportedTransactionVersions);

        if (SolanaSignTransaction in this.#wallet.features && this.#account?.features.includes(SolanaSignTransaction)) {
            this.signTransaction = this.#signTransaction;
            this.signAllTransactions = this.#signAllTransactions;
        } else {
            delete this.signTransaction;
            delete this.signAllTransactions;
        }

        if (SolanaSignMessage in this.#wallet.features && this.#account?.features.includes(SolanaSignMessage)) {
            this.signMessage = this.#signMessage;
        } else {
            delete this.signMessage;
        }

        if (SolanaSignIn in this.#wallet.features) {
            this.signIn = this.#signIn;
        } else {
            delete this.signIn;
        }
    }

    #changed: StandardEventsListeners['change'] = (properties) => {
        // If accounts have changed on the wallet, reflect this on the adapter.
        if ('accounts' in properties) {
            const account = this.#wallet.accounts[0];
            // If the adapter isn't connected, or is disconnecting, or the first account hasn't changed, do nothing.
            if (this.#account && !this.#disconnecting && account !== this.#account) {
                // If there's a connected account, connect the adapter. Otherwise, disconnect it.
                if (account) {
                    // Connect the adapter.
                    this.#connected(account);
                } else {
                    // Emit an error because the wallet spontaneously disconnected.
                    this.emit('error', new WalletDisconnectedError());
                    // Disconnect the adapter.
                    this.#disconnected();
                }
            }
        }

        // After reflecting account changes, if features have changed on the wallet, reflect this on the adapter.
        if ('features' in properties) {
            this.#reset();
        }
    };

    async sendTransaction<T extends BaseTransactionMessage>(
        transaction: T,
        rpc: Rpc<SolanaRpcApi>,
        options: SendTransactionConfig = {
            encoding: 'base64',
        }
    ): Promise<Signature> {
        try {
            const account = this.#account;
            if (!account) throw new WalletNotConnectedError();

            let feature: typeof SolanaSignAndSendTransaction | typeof SolanaSignTransaction;
            if (SolanaSignAndSendTransaction in this.#wallet.features) {
                if (account.features.includes(SolanaSignAndSendTransaction)) {
                    feature = SolanaSignAndSendTransaction;
                } else if (
                    SolanaSignTransaction in this.#wallet.features &&
                    account.features.includes(SolanaSignTransaction)
                ) {
                    feature = SolanaSignTransaction;
                } else {
                    throw new WalletAccountError();
                }
            } else if (SolanaSignTransaction in this.#wallet.features) {
                if (!account.features.includes(SolanaSignTransaction)) throw new WalletAccountError();
                feature = SolanaSignTransaction;
            } else {
                throw new WalletConfigError();
            }

            const chain = getChainForEndpoint(
                this.endpoint ?? 'https://api.mainnet-beta.solana.com'
                //  ?? rpc.endpoint);
            );
            // if (!account.chains.includes(chain)) throw new WalletSendTransactionError();
            async function getOrPassBlockhash<T extends TransactionMessageWithLifetime>(transaction: T) {
                return 'lifetimeConstraint' in transaction &&
                    'blockhash' in transaction.lifetimeConstraint &&
                    'blockhash' in transaction.lifetimeConstraint
                    ? transaction.lifetimeConstraint
                    : await rpc
                          .getLatestBlockhash({
                              commitment: options.preflightCommitment,
                              minContextSlot: options.minContextSlot,
                          })
                          .send()
                          .then((res) => res.value);
            }
            try {
                const { signers, ...sendOptions } = options;
                const blockhashOpts = await getOrPassBlockhash(transaction);
                let serializedTransaction: Base64EncodedWireTransaction;
                if (isVersionedTransaction(transaction)) {
                    serializedTransaction = await pipe(
                        transaction,
                        async (msg) => this.prepareTransaction(msg, blockhashOpts),
                        async (msg) => compileTransaction(await msg),
                        async (msg) =>
                            signers?.length
                                ? await signTransaction(
                                      signers.map((s) => s.keyPair),
                                      await msg
                                  )
                                : await msg,
                        async (msg) => getBase64EncodedWireTransaction(await msg)
                    );
                } else {
                    serializedTransaction = await pipe(
                        transaction,
                        async (msg) => this.prepareTransaction(msg, blockhashOpts),
                        async (msg) => compileTransaction(await msg),
                        async (msg) =>
                            signers?.length
                                ? await partiallySignTransaction(
                                      signers.map((s) => s.keyPair),
                                      await msg
                                  )
                                : await msg,
                        async (msg) => getBase64EncodedWireTransaction(await msg)
                    );
                    // serializedTransaction = new Uint8Array(
                    //     (transaction as Transaction).serialize({
                    //         requireAllSignatures: false,
                    //         verifySignatures: false,
                    //     })
                    // );
                }

                if (feature === SolanaSignAndSendTransaction) {
                    const [output] = await (this.#wallet.features as SolanaSignAndSendTransactionFeature)[
                        SolanaSignAndSendTransaction
                    ].signAndSendTransaction({
                        account,
                        chain,
                        transaction: Uint8Array.from(serializedTransaction.split('').map((s) => s.charCodeAt(0))),
                        options: {
                            preflightCommitment: getCommitment(
                                sendOptions.preflightCommitment
                                // || connection.commitment
                            ),
                            skipPreflight: sendOptions.skipPreflight,
                            maxRetries: sendOptions.maxRetries as number | undefined,
                            minContextSlot: sendOptions.minContextSlot as number | undefined,
                        },
                    });

                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    return signature(bs58.encode(output!.signature));
                } else {
                    const [output] = await (this.#wallet.features as SolanaSignTransactionFeature)[
                        SolanaSignTransaction
                    ].signTransaction({
                        account,
                        chain,
                        transaction: Uint8Array.from(serializedTransaction.split('').map((s) => s.charCodeAt(0))),
                        options: {
                            preflightCommitment: getCommitment(
                                sendOptions.preflightCommitment
                                //  || rpc.commitment
                            ),
                            minContextSlot: sendOptions.minContextSlot as number | undefined,
                        },
                    });

                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    return await rpc
                        .sendTransaction(
                            getBase64EncodedWireTransaction(getTransactionDecoder().decode(output!.signedTransaction)),
                            {
                                ...sendOptions,
                                preflightCommitment: getCommitment(
                                    sendOptions.preflightCommitment
                                    // ||  connection.commitment),
                                ),
                            }
                        )
                        .send();
                }
            } catch (error: any) {
                if (error instanceof WalletError) throw error;
                throw new WalletSendTransactionError(error?.message, error);
            }
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }

    signTransaction: (<T extends CompilableTransactionMessage>(transaction: T) => Promise<T>) | undefined;
    async #signTransaction<T extends CompilableTransactionMessage>(transaction: T): Promise<T> {
        try {
            const account = this.#account;
            if (!account) throw new WalletNotConnectedError();
            if (!(SolanaSignTransaction in this.#wallet.features)) throw new WalletConfigError();
            if (!account.features.includes(SolanaSignTransaction)) throw new WalletAccountError();

            try {
                const signedTransactions = await this.#wallet.features[SolanaSignTransaction].signTransaction({
                    account,
                    transaction: Uint8Array.from(
                        getBase64EncodedWireTransaction(compileTransaction(transaction))
                            .split('')
                            .map((s) => s.charCodeAt(0))
                    ),
                    // ? transaction.serialize()
                    // : new Uint8Array(
                    //       transaction.serialize({
                    //           requireAllSignatures: false,
                    //           verifySignatures: false,
                    //       })
                    //   ),
                });

                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const serializedTransaction = signedTransactions[0]!.signedTransaction;

                const txDecoder = getTransactionDecoder();
                const decodedTransaction = txDecoder.decode(serializedTransaction);
                const compiledTransactionMessage = getCompiledTransactionMessageDecoder().decode(
                    decodedTransaction.messageBytes
                );
                const decompiledTransactionMessage = decompileTransactionMessage(compiledTransactionMessage);
                return decompiledTransactionMessage as T;
            } catch (error: any) {
                if (error instanceof WalletError) throw error;
                throw new WalletSignTransactionError(error?.message, error);
            }
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }

    signAllTransactions: (<T extends CompilableTransactionMessage>(transaction: T[]) => Promise<T[]>) | undefined;
    async #signAllTransactions<T extends CompilableTransactionMessage>(transactions: T[]): Promise<T[]> {
        try {
            const account = this.#account;
            if (!account) throw new WalletNotConnectedError();

            if (!(SolanaSignTransaction in this.#wallet.features)) throw new WalletConfigError();
            if (!account.features.includes(SolanaSignTransaction)) throw new WalletAccountError();

            try {
                const signedTransactions = await this.#wallet.features[SolanaSignTransaction].signTransaction(
                    ...transactions.map((transaction) => ({
                        account,
                        transaction: Uint8Array.from(
                            getBase64EncodedWireTransaction(compileTransaction(transaction))
                                .split('')
                                .map((s) => s.charCodeAt(0))
                        ),
                        // ? transaction.serialize()
                        // : new Uint8Array(
                        //       transaction.serialize({
                        //           requireAllSignatures: false,
                        //           verifySignatures: false,
                        //       })
                        //   ),
                    }))
                );

                return transactions.map((transaction, index) => {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const signedTransaction = signedTransactions[index]!.signedTransaction;

                    const txDecoder = getTransactionDecoder();
                    const decodedTransaction = txDecoder.decode(signedTransaction);
                    const compiledTransactionMessage = getCompiledTransactionMessageDecoder().decode(
                        decodedTransaction.messageBytes
                    );
                    const decompiledTransactionMessage = decompileTransactionMessage(compiledTransactionMessage);
                    return decompiledTransactionMessage as T;
                });
            } catch (error: any) {
                throw new WalletSignTransactionError(error?.message, error);
            }
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }

    signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
    async #signMessage(message: Uint8Array): Promise<Uint8Array> {
        try {
            const account = this.#account;
            if (!account) throw new WalletNotConnectedError();

            if (!(SolanaSignMessage in this.#wallet.features)) throw new WalletConfigError();
            if (!account.features.includes(SolanaSignMessage)) throw new WalletAccountError();

            try {
                const signedMessages = await this.#wallet.features[SolanaSignMessage].signMessage({
                    account,
                    message,
                });

                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                return signedMessages[0]!.signature;
            } catch (error: any) {
                throw new WalletSignMessageError(error?.message, error);
            }
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }

    signIn: ((input?: SolanaSignInInput) => Promise<SolanaSignInOutput>) | undefined;
    async #signIn(input: SolanaSignInInput = {}): Promise<SolanaSignInOutput> {
        try {
            if (!(SolanaSignIn in this.#wallet.features)) throw new WalletConfigError();

            let output: SolanaSignInOutput | undefined;
            try {
                [output] = await this.#wallet.features[SolanaSignIn].signIn(input);
            } catch (error: any) {
                throw new WalletSignInError(error?.message, error);
            }

            if (!output) throw new WalletSignInError();
            this.#connected(output.account);
            return output;
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }
}
