import { MANAGEMENT_FEE_DIVIDER, RETRY_CONFIG, vaults } from "./constants";
import { Address, Builder, fromNano, OpenedContract, toNano } from "@ton/core";
import {
  JettonJettonTonStrategy,
  TonJettonTonStrategy,
  Vault,
} from "@parraton/sdk";
import { tonClient } from "./ton-client";
import memoizee from "memoizee";
import asyncRetry from "async-retry";
import {
  JJT_REINVEST_FEE,
  MIN_CLAIM_AMOUNT,
  MIN_REINVEST_AMOUNT,
  MIN_VAULT_BALANCE,
  TJT_REINVEST_FEE,
} from "./config";
import { managerWalletPromise } from "./wallet";
import { logOperation } from "./log";
import { wait } from "./wait";
import { Asset, Pool } from "@dedust/sdk";
import {
  getDistributionAccountAccumulatedRewards,
  getDistributionAccountClaimedRewards,
  getDistributionPool,
  getRewardsDictionary,
} from "./distribution.utils";

const getAccountTonBalance = async (accountAddress: Address) => {
  const {
    last: { seqno },
  } = await asyncRetry(
    async () => (await tonClient).getLastBlock(),
    RETRY_CONFIG
  );
  const { account } = await asyncRetry(
    async () => (await tonClient).getAccountLite(seqno, accountAddress),
    RETRY_CONFIG
  );
  return toNano(fromNano(account.balance.coins));
};

const isClaimRewardsNeeded = async (
  distributionPoolAddress: Address,
  vaultAddress: Address
) => {
  const claimedRewards = await getDistributionAccountClaimedRewards(
    distributionPoolAddress,
    vaultAddress
  );
  const accumulatedRewards = await getDistributionAccountAccumulatedRewards(
    distributionPoolAddress,
    vaultAddress
  );
  console.log(
    "Accumulated rewards",
    fromNano(accumulatedRewards),
    "Claimed rewards",
    fromNano(claimedRewards)
  );
  return accumulatedRewards - claimedRewards > MIN_CLAIM_AMOUNT;
};

const getAmountToReinvest = memoizee(
  async (vault: OpenedContract<Vault>) => {
    const vaultBalance = await getAccountTonBalance(vault.address);
    const { managementFee, managementFeeRate } = await getVaultData(vault);
    return (
      ((vaultBalance - MIN_VAULT_BALANCE - managementFee) *
        (MANAGEMENT_FEE_DIVIDER - managementFeeRate)) /
      MANAGEMENT_FEE_DIVIDER
    );
  },
  {
    maxAge: 60_000,
    promise: true,
  }
);

const isReinvestRewardsNeeded = async (vault: OpenedContract<Vault>) => {
  const totalReward = await getAmountToReinvest(vault);
  console.log("Total reward", fromNano(totalReward));
  return totalReward > MIN_REINVEST_AMOUNT;
};

const claimRewards = async (
  distributionPoolAddress: Address,
  vaultAddress: Address
) => {
  const rewardsDictionary = await getRewardsDictionary(distributionPoolAddress);
  if (!rewardsDictionary) {
    return;
  }
  const proof = rewardsDictionary.generateMerkleProof([vaultAddress]);
  const distributionPool = await getDistributionPool(distributionPoolAddress);
  const { sender: manager, wallet } = await managerWalletPromise;

  if (!(await isBalanceEnough(wallet.address, toNano(0.2)))) {
    console.log("Not enough balance to claim rewards");
    return;
  }

  await distributionPool.sendClaim(manager, {
    userAddress: vaultAddress,
    proof,
  });
};

export enum PoolType {
  TON_JETTON,
  JETTON_JETTON,
}

const getPool = memoizee(
  async (poolAddress: Address) => {
    const rawPool = Pool.createFromAddress(poolAddress);
    const pool = await (await tonClient).open(rawPool);
    return pool;
  },
  {
    maxAge: 60_000,
    promise: true,
  }
);

export async function getPoolType(poolAddress: Address) {
  const pool = await getPool(poolAddress);
  const assets = await pool.getAssets();
  return assets[0].address && assets[1].address
    ? PoolType.JETTON_JETTON
    : PoolType.TON_JETTON;
}

async function getStrategy(strategyAddress: Address) {
  const rawStrategy = TonJettonTonStrategy.createFromAddress(strategyAddress);
  const strategy = await (await tonClient).open(rawStrategy);

  let poolType: PoolType;
  try {
    const poolAddress = await strategy.getStrategyPoolAddress();
    poolType = await getPoolType(poolAddress);
  } catch (e) {
    poolType = PoolType.JETTON_JETTON;
  }

  return {
    strategy:
      poolType === PoolType.JETTON_JETTON
        ? await (
            await tonClient
          ).open(JettonJettonTonStrategy.createFromAddress(strategyAddress))
        : strategy,
    poolType,
  };
}

const getReinvestFee = (poolType: PoolType) => {
  return poolType === PoolType.JETTON_JETTON
    ? JJT_REINVEST_FEE
    : TJT_REINVEST_FEE;
};

const getTonToJettonSwapParams = async (
  poolAddress: Address,
  tonToReinvest: bigint
): Promise<{ amountToSwap: bigint; swapLimit: bigint }> => {
  const pool = await getPool(poolAddress);
  const amountToSwap = tonToReinvest / 2n;

  const { amountOut } = await pool.getEstimatedSwapOut({
    assetIn: Asset.native(),
    amountIn: amountToSwap,
  });

  return { amountToSwap, swapLimit: (amountOut * 9n) / 10n };
};

const getUsdtToJettonSwapParams = async (
  poolAddress: Address,
  usdtAddress: Address,
  usdtBalance: bigint
): Promise<{ amountToSwap: bigint; swapLimit: bigint }> => {
  const pool = await getPool(poolAddress);
  const amountToSwap = usdtBalance / 2n;

  const { amountOut } = await pool.getEstimatedSwapOut({
    assetIn: Asset.jetton(usdtAddress),
    amountIn: amountToSwap,
  });

  return { amountToSwap, swapLimit: (amountOut * 9n) / 10n };
};

const getTonJettonDepositParams = async (
  strategy: OpenedContract<TonJettonTonStrategy>,
  tonToInvest: bigint,
  jettonToInvest: bigint
): Promise<{
  tonTargetBalance: bigint;
  jettonTargetBalance: bigint;
  depositLimit: bigint;
}> => {
  const { poolAddress } = await strategy.getStrategyData();
  const pool = await getPool(poolAddress);

  const {
    deposits: [tonTargetBalance, jettonTargetBalance],
    fairSupply,
  } = await pool.getEstimateDepositOut([tonToInvest, jettonToInvest]);

  return {
    tonTargetBalance,
    jettonTargetBalance,
    depositLimit: (fairSupply * 9n) / 10n,
  };
};

const getUsdtJettonDepositParams = async (
  strategy: OpenedContract<JettonJettonTonStrategy>,
  usdtToInvest: bigint,
  jettonToInvest: bigint
): Promise<{
  usdtTargetBalance: bigint;
  jettonTargetBalance: bigint;
  depositLimit: bigint;
}> => {
  const { poolAddress, usdtMasterAddress } = await strategy.getStrategyData();
  const pool = await getPool(poolAddress);
  const assets = await pool.getAssets();
  const isUsdtFirst = assets[0].address === usdtMasterAddress;

  const { deposits, fairSupply } = await pool.getEstimateDepositOut(
    isUsdtFirst
      ? [usdtToInvest, jettonToInvest]
      : [jettonToInvest, usdtToInvest]
  );

  return {
    usdtTargetBalance: isUsdtFirst ? deposits[0] : deposits[1],
    jettonTargetBalance: isUsdtFirst ? deposits[1] : deposits[0],
    depositLimit: (fairSupply * 9n) / 10n,
  };
};

const prepareTjtReinvestParams = async (
  strategyAddress: Address,
  tonToReinvest: bigint
) => {
  const rawStrategy = TonJettonTonStrategy.createFromAddress(strategyAddress);
  const strategy = await (await tonClient).open(rawStrategy);
  const { poolAddress } = await strategy.getStrategyData();
  const { amountToSwap, swapLimit } = await getTonToJettonSwapParams(
    poolAddress,
    tonToReinvest
  );
  const { tonTargetBalance, jettonTargetBalance, depositLimit } =
    await getTonJettonDepositParams(
      strategy,
      tonToReinvest - amountToSwap,
      swapLimit
    );

  return strategy.packReinvestData({
    amountToSwap,
    swapLimit,
    tonTargetBalance,
    jettonTargetBalance,
    depositLimit,
    depositFee: toNano(0.3),
    depositFwdFee: toNano(0.25),
    transferFee: toNano(0.05),
    deadline: Math.floor(Date.now() / 1000 + 86400),
  });
};

const prepareJjtReinvestParams = async (
  strategyAddress: Address,
  tonToReinvest: bigint
) => {
  const rawStrategy =
    JettonJettonTonStrategy.createFromAddress(strategyAddress);
  const strategy = await (await tonClient).open(rawStrategy);
  const { usdtTonPoolAddress, poolAddress, usdtMasterAddress } =
    await strategy.getStrategyData();
  const { amountToSwap: amountToSwap0, swapLimit: swap0Limit } =
    await getTonToJettonSwapParams(usdtTonPoolAddress, tonToReinvest);
  const { amountToSwap: amountToSwap1, swapLimit: swap1Limit } =
    await getUsdtToJettonSwapParams(
      poolAddress,
      usdtMasterAddress,
      swap0Limit // jetton amount to swap
    );
  const { usdtTargetBalance, jettonTargetBalance, depositLimit } =
    await getUsdtJettonDepositParams(
      strategy,
      swap0Limit - amountToSwap1,
      swap1Limit
    );

  return strategy.packReinvestData({
    amountToSwap0,
    amountToSwap1,
    swap0Limit,
    swap1Limit,
    depositLimit,
    usdtTargetBalance,
    jettonTargetBalance,
    swapFwdFee: toNano(0.3),
    depositFee: toNano(0.45),
    depositFwdFee: toNano(0.4),
    transferFee: toNano(0.05),
    deadline: Math.floor(Date.now() / 1000 + 86400),
  });
};

export const isBalanceEnough = async (userAddress: Address, value: bigint) => {
  const balance = await getAccountTonBalance(userAddress);
  console.log(
    "Address",
    userAddress.toString(),
    "Balance",
    fromNano(balance),
    "Value",
    fromNano(value)
  );
  return balance >= value;
};

const reinvestRewards = async (vault: OpenedContract<Vault>) => {
  const { sender: manager, wallet } = await managerWalletPromise;
  const { strategyAddress } = await getVaultData(vault);
  const totalReward = await getAmountToReinvest(vault);
  const { poolType } = await getStrategy(strategyAddress);
  const value = getReinvestFee(poolType);

  let strategyBuilder: Builder;
  switch (poolType) {
    case PoolType.TON_JETTON:
      strategyBuilder = await prepareTjtReinvestParams(
        strategyAddress,
        totalReward
      );
      break;
    case PoolType.JETTON_JETTON:
      strategyBuilder = await prepareJjtReinvestParams(
        strategyAddress,
        totalReward
      );
      break;
  }

  if (!(await isBalanceEnough(wallet.address, value))) {
    return;
  }
  await vault.sendReinvest(manager, { value, totalReward, strategyBuilder });
};

const claimRewardsWithLog = async (
  distributionPoolAddress: Address,
  vaultAddress: Address
) => {
  const { wallet: managerWallet } = await managerWalletPromise;
  const claimHash = await wait(managerWallet.address.toString(), () =>
    claimRewards(distributionPoolAddress, vaultAddress)
  );
  logOperation("Claim rewards", claimHash);
};

const reinvestRewardsWithLog = async (vault: OpenedContract<Vault>) => {
  const { wallet: managerWallet } = await managerWalletPromise;
  const hash = await wait(managerWallet.address.toString(), () =>
    reinvestRewards(vault)
  );
  logOperation("Reinvest rewards", hash);
};

export const getVaultData = memoizee(
  async (vault: OpenedContract<Vault>) => {
    return asyncRetry(async () => vault.getVaultData(), RETRY_CONFIG);
  },
  {
    maxAge: 60_000,
    promise: true,
  }
);

const compoundVault = async (vaultAddress: Address) => {
  console.log("Compounding vault", vaultAddress.toString());
  const vault = (await tonClient).open(Vault.createFromAddress(vaultAddress));
  const { distributionPoolAddress } = await getVaultData(vault);

  if (await isClaimRewardsNeeded(distributionPoolAddress, vaultAddress)) {
    console.log("Claiming rewards");
    await claimRewardsWithLog(distributionPoolAddress, vaultAddress);
  }
  if (await isReinvestRewardsNeeded(vault)) {
    console.log("Reinvesting rewards");
    await reinvestRewardsWithLog(vault);
  }
};

export const compoundAllVaults = async () => {
  for (const vault of vaults) {
    await compoundVault(Address.parse(vault));
  }
};
