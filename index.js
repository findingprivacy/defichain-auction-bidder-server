require('dotenv').config();
const express = require('express');
const { JsonRpcClient } = require('@defichain/jellyfish-api-jsonrpc');
const BigNumber = require('bignumber.js');
const cors = require('cors');
const SimpleNodeLogger = require('simple-node-logger');

const logger = SimpleNodeLogger.createSimpleFileLogger({
  logFilePath: `${Date.now()}.log`,
  timestampFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
});
const app = express();
const client = new JsonRpcClient(process.env.CLIENT_ENDPOINT_URL);

const logError = (message, error) => {
  logger.error(message);
  console.log(message, error);
};

const checkRequiredConfig = () => {
  const { CLIENT_ENDPOINT_URL, PORT, COOL_DOWN } = process.env;
  if (!CLIENT_ENDPOINT_URL || !PORT || !COOL_DOWN) {
    logError('MISSING REQUIRED CONFIG SETTING');
    process.exit();
  }
};

// eslint-disable-next-line no-promise-executor-return
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

checkRequiredConfig();

app.use(cors());

const getAvailableAuctions = async (limit) => {
  const availableAuctions = await client.loan.listAuctions({ limit });
  return availableAuctions.reduce((acc, { vaultId, batches }) => {
    const transformedBatches = batches.map(batch => ({ ...batch, vaultId }));
    return [...acc, ...transformedBatches];
  }, []);
};

const getPriceInDUSD = async (amount, symbol) => {
  if (symbol === 'DUSD') {
    const amountNum = new BigNumber(amount);
    return amountNum;
  }
  try {
    if (symbol === 'DFI') {
      const poolPair = await client.poolpair.getPoolPair('DUSD-DFI');
      const [rate] = Object.entries(poolPair).map(([, pair]) => pair['reserveA/reserveB']);
      return rate.multipliedBy(amount);
    }
    const poolPair = await client.poolpair.getPoolPair(`${symbol}-DUSD`);
    const [rate] = Object.entries(poolPair).map(([, pair]) => pair['reserveB/reserveA']);
    return rate.multipliedBy(amount);
  } catch (error) {
    if (error.message.includes('Pool not found')) {
      const [firstPair, secondPair] = await Promise.all([
        client.poolpair.getPoolPair(`${symbol}-DFI`),
        client.poolpair.getPoolPair('DUSD-DFI'),
      ]);
      const [firstRate] = Object.entries(firstPair).map(([, pair]) => pair['reserveB/reserveA']);
      const [secondRate] = Object.entries(secondPair).map(([, pair]) => pair['reserveA/reserveB']);
      return firstRate.multipliedBy(amount).multipliedBy(secondRate);
    }
    logError('getPriceInDUSD error', error);
    return null;
  }
};

const getMaxPrice = async (amount, symbol) => {
  if (symbol === 'DUSD') {
    const amountNum = new BigNumber(amount);
    return amountNum.multipliedBy('0.99');
  }
  try {
    const poolPair = await client.poolpair.getPoolPair(`${symbol}-DUSD`);
    const [rate] = Object.entries(poolPair).map(([, pair]) => pair['reserveA/reserveB']);
    return rate.multipliedBy(amount).multipliedBy('0.99');
  } catch (error) {
    logError('getMaxPrice error', symbol, error);
    return null;
  }
};

const getStartingBid = async (vault, batchIndex, amount, symbol) => {
  const highestBidSoFar = vault.batches?.[batchIndex]?.highestBid;

  if (!highestBidSoFar) {
    const loanNum = await getPriceInDUSD(amount, symbol);
    return loanNum.multipliedBy('1.05');
  }

  const [highestBidAmount] = highestBidSoFar.amount.split('@');
  const highestBidSoFarNum = await getPriceInDUSD(highestBidAmount, symbol);
  return highestBidSoFarNum.multipliedBy('1.01');
};

const getMyStartingBid = (vault, batchIndex, amount, myPriceInDusd) => {
  const highestBidSoFar = vault.batches?.[batchIndex]?.highestBid;
  if (!highestBidSoFar) return myPriceInDusd.multipliedBy(amount).multipliedBy('1.05');
  const [highestBidAmount] = highestBidSoFar.amount.split('@');
  return myPriceInDusd.multipliedBy(highestBidAmount).multipliedBy('1.01');
};

const getRewardPrice = async (collaterals) => {
  const pricePromises = collaterals.map((collateral) => {
    const [amount, symbol] = collateral.split('@');
    return getPriceInDUSD(amount, symbol);
  });
  const prices = await Promise.all(pricePromises);
  return prices.reduce((sum, price) => sum.plus(price), new BigNumber(0));
};

const getAuctionCondition = (margin, diff, minMarginPercentage) => {
  if (!margin || !diff) return false;
  return margin.isGreaterThanOrEqualTo(minMarginPercentage) && diff.isGreaterThan(1);
};

const getOwnPriceData = ({ symbol, vault, batchIndex, minBid, reward }) => {
  if (!process.env[symbol]) return {};
  const myPriceInDusd = new BigNumber(process.env[symbol]);
  const myStartingBid = getMyStartingBid(vault, batchIndex, minBid, myPriceInDusd);
  const myDiff = reward.minus(myStartingBid);
  const myMargin = myDiff.dividedBy(myStartingBid).multipliedBy(100);
  const ownPriceData = { myStartingBid, myDiff, myMargin };
  return ownPriceData;
};

app.get('/get-auction-list/:limit', async (req, res) => {
  try {
    const limit = parseInt(req.params.limit, 10);
    const { minMarginPercentage = 0 } = req.query;
    const availableAuctions = await getAvailableAuctions(limit);

    const result = [];
    for (let index = 0; index < availableAuctions.length; index += 1) {
      const { vaultId, index: batchIndex, loan, collaterals } = availableAuctions[index];
      const vault = await client.loan.getVault(vaultId);
      const [minBid, symbol] = loan.split('@');
      const startingBid = await getStartingBid(vault, batchIndex, minBid, symbol);
      const reward = await getRewardPrice(collaterals);
      const url = `https://defiscan.live/vaults/${vaultId}/auctions/${batchIndex}`;
      const diff = reward.minus(startingBid);
      const margin = diff.dividedBy(startingBid).multipliedBy(100);
      const coolDown = parseInt(process.env.COOL_DOWN, 10);
      const maxPrice = await getMaxPrice(reward, symbol);

      wait(coolDown);

      const ownPriceData = getOwnPriceData({ symbol, vault, batchIndex, minBid, reward });
      const tokenCondition = getAuctionCondition(margin, diff, minMarginPercentage);
      const myTokenCondition = getAuctionCondition(ownPriceData.myMargin, ownPriceData.myDiff, minMarginPercentage);

      if (tokenCondition || myTokenCondition) {
        result.push({
          url,
          minBidDusd: startingBid,
          reward,
          diff,
          margin,
          maxBlockNumber: vault.liquidationHeight,
          bidToken: symbol,
          maxPrice,
          minBid,
          ...ownPriceData,
        });
      }
    }

    const auctions = result.map(({
      url,
      minBidDusd,
      reward,
      diff,
      margin,
      maxPrice,
      maxBlockNumber,
      bidToken,
      minBid,
      myStartingBid,
      myDiff,
      myMargin,
    }) => {
      const auctionData = {
        url,
        minBidDusd: minBidDusd.toString(),
        reward: reward.toString(),
        diff: diff.toString(),
        margin: margin.toString(),
        maxPrice: maxPrice.toString(),
        maxBlockNumber,
        bidToken: bidToken.toString(),
        minBid: minBid.toString(),
      };
      if (myStartingBid) auctionData.myStartingBid = myStartingBid;
      if (myDiff) auctionData.myDiff = myDiff;
      if (myMargin) auctionData.myMargin = myMargin;
      return auctionData;
    });
    res.json(auctions);
  } catch (error) {
    logError('get-auction-list error', error);
    res.status(500);
    res.send('Internal Server Error');
  }
});

app.listen(parseInt(process.env.PORT, 10), () => {
  console.log(`Example app listening on port ${process.env.PORT}`);
});
