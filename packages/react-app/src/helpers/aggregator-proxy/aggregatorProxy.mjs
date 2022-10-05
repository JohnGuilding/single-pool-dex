import { ethers, BigNumber } from "ethers";
import { Aggregator, BlsWalletWrapper, AggregatorUtilities__factory, initBlsWalletSigner } from "bls-wallet-clients";
import pkg from "bls-wallet-aggregator-proxy";
import pk from "../../../aggregatorProxyPrivateKey.js";
const { runAggregatorProxy } = pkg;
const { privateKey } = pk;
import config from "./config.json" assert { type: "json" };

(async () => {
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  const wallet = await BlsWalletWrapper.connect(privateKey, config.verificationGateway, provider);
  
  const blsWalletSigner = await initBlsWalletSigner({
    chainId: config.chainId,
  });

  const upstreamAggregator = new Aggregator(config.aggregator);
  const utils = AggregatorUtilities__factory.connect(config.aggregatorUtilities, provider);

  runAggregatorProxy(
    config.aggregator,
    async clientBundle => {
      const isSponsored = clientBundle.operations.every(op =>
        op.actions.every(action => config.sponsoredContracts.includes(action.contractAddress)),
      );

      if (!isSponsored) {
        return clientBundle;
      }

      const fees = await upstreamAggregator.estimateFee(
        blsWalletSigner.aggregate([
          clientBundle,
          wallet.sign({
            nonce: await wallet.Nonce(),
            actions: [
              {
                // Use send of 1 wei to measure fee that includes our payment
                ethValue: 1,
                contractAddress: utils.address,
                encodedFunction: utils.interface.encodeFunctionData("sendEthToTxOrigin"),
              },
            ],
          }),
        ]),
      );

      if (!fees.successes.every(s => s) || fees.feeType !== "ether") {
        return clientBundle;
      }

      const remainingFee = BigNumber.from(fees.feeRequired).sub(fees.feeDetected);

      // pay a bit more than expected to increase chances of success
      const paymentAmount = remainingFee.add(remainingFee.div(10));

      const paymentBundle = wallet.sign({
        nonce: await wallet.Nonce(),
        actions: [
          {
            ethValue: paymentAmount,
            contractAddress: utils.address,
            encodedFunction: utils.interface.encodeFunctionData("sendEthToTxOrigin"),
          },
        ],
      });

      return blsWalletSigner.aggregate([clientBundle, paymentBundle]);
    },
    config.port,
    config.hostname,
    () => {
      console.log(`Proxying ${config.aggregator} on ${config.hostname}:${config.port}`);
    },
  );
})().catch(error => {
  setTimeout(() => {
    console.log("ERROR: ", error);
    throw error;
  });
});
