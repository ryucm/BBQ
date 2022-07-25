import {
    isObject, isFunction, isNumber,
    orderBy,
    pick,
    snakeCase,
    uniqBy,
  } from 'lodash';
  import assert from 'assert';
  import axios from 'axios';
  import { GraphQLClient } from 'graphql-request';
  import s3tree from 's3-tree';
  
  import moment from 'moment';
  
  import config from '../config';
  import { Queue } from './job';
  import sendSlack from './sendSlack';
  import {
    logger,
    lastDateOfMonth,
    dateRange,
    formatDate,
    yesterday,
    lastWeek,
    lastMonth,
    formatNumber,
    formatDuration,
    delay,
    randomSha1,
    renameKeys,
    camelCase,
    uploadToS3,
    getObjectFromS3,
    capitalize,
    debugLog,
    padString,
    isValidUrl,
  } from './util';
  
  
  // Utilities
  // =========
  
  
  const client = new GraphQLClient(config.dataEndpoint, {});
  
  const normalizeRetailSourceData = data => pick(renameKeys({
  }, camelCase(data)), [
    'country',
    'language',
    'url',
    'name',
    'summary',
    'description',
  ]);
  
  const normalizeRawInventoryPrice = data => pick(renameKeys({
    source: 'sourceId',
    country: 'countryId',
  }, camelCase(data)), [
    'category',
    'currency',
    'countryId',
    'name',
    'hash',
    'sourceId',
    'imageUrl',
    'date',
    'origin',
    'region',
    'originalPrice',
    'pageUrl',
    'price',
    'unit',
  ]);
  
  const normalizeSourceData = data => pick(renameKeys({
    url: 'website',
  }, camelCase(data)), [
    'country',
    'language',
    'name',
    'website',
    'summary',
    'description',
    'isHistorySupported',
    'method',
  ]);
  
  const normalizeRawPriceData = data => pick(renameKeys({
    source: 'sourceId',
    country: 'countryId',
    product: 'productRaw',
    variety: 'varietyRaw',
    grade: 'gradeRaw',
    unit: 'unitRaw',
    region: 'regionRaw',
    origin: 'originRaw',
  }, camelCase(data)), [
    'hash',
    'sourceId',
    'countryId',
    'type',
    'productRaw',
    'varietyRaw',
    'gradeRaw',
    'unitRaw',
    'regionRaw',
    'originRaw',
    'pageUrl',
    'imageUrl',
    'date',
    'currency',
    'priceMin',
    'priceMax',
    'priceAvg',
    'memo',
    'volume',
    'volumeUnit',
  ]);
  
  async function createOrUpdateSource(data, type) {
    logger.info(`Creating/Updating source '${data.name}'`);
  
    // For backward compatibility
    data = (
      type === 'data'
        ? normalizeSourceData(data)
        : normalizeRetailSourceData(data)
    );
  
    const queryByTypes = {
      data: `mutation createOrUpdateSource($data: NonUniqueSourceMutationInput!) {
        createOrUpdateSource(data: $data) {
          ok
          errors {
            field
            messages
          }
          data {
            id
            name
          }
        }
      }`,
      merchandise: `mutation createOrUpdateRetailSource($data: NonUniqueRetailSourceMutationInput!) {
        createOrUpdateRetailSource(data: $data) {
          ok
          errors {
            field
            messages
          }
          data {
            id
            name
          }
        }
      }`,
    };
  
    try {
      const response = await client.request(queryByTypes[type], { data });
      const result = type === 'data'
        ? response.createOrUpdateSource
        : response.createOrUpdateRetailSource;
  
      if (!result.ok) {
        logger.error('Failed to create/update source:', result.errors);
        return null;
      }
  
      return result.data;
    } catch (e) {
      logger.error('Something went wrong while requesting: ', e);
      return null;
    }
  }
  
  async function push(sourceId, hash, prices, type) {
    if (!prices) {
      logger.warn('No prices to push');
      return;
    }
  
    logger.info(`Pushing ${prices.length} prices to the source '${sourceId}' (hash: ${hash})`);
  
    const normalizerByType = {
      data: normalizeRawPriceData,
      merchandise: normalizeRawInventoryPrice,
    };
  
    const data = prices.map((price) => {
      if (price.priceAvg !== undefined && Number(price.priceAvg) % 1) {
        price.priceAvg = Number(Number(price.priceAvg).toFixed(9));
      }
      if (price.priceMin !== undefined && Number(price.priceMin) % 1) {
        price.priceMin = Number(Number(price.priceMin).toFixed(9));
      }
      if (price.priceMax !== undefined && Number(price.priceMax) % 1) {
        price.priceMax = Number(Number(price.priceMax).toFixed(9));
      }
      if (price.pageUrl === decodeURI(price.pageUrl)) {
        price.pageUrl = encodeURI(price.pageUrl);
      }
      return normalizerByType[type]({
        source: sourceId,
        hash,
        ...price,
      });
    });
  
    const queryByTypes = {
      data: `mutation bulkCreateRawPrice($data: [FlatRawPriceMutationInput]!) {
        bulkCreateRawPrice(data: $data) {
          ok
          errors {
            field
            messages
          }
        }
      }`,
      merchandise: `mutation bulkCreateRawInventoryPrice($data: [FlatRawInventoryPriceMutationInput]!) {
        bulkCreateRawInventoryPrice(data: $data) {
          ok
          errors {
            field
            messages
          }
        }
      }`,
    };
  
    try {
      const response = await axios({
        data,
        method: 'POST',
        url: `${config.kafkaHost}/raw-price/bulk-create`,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      });
      logger.info(`Succesfully pushed into golmok: ${response}`);
    } catch (e) {
      logger.error('Something went wrong while requesting to golmok: ', e);
    }
  
    try {
      const response = await client.request(queryByTypes[type], { data });
      const result = (
        type === 'data'
          ? response.bulkCreateRawPrice
          : response.bulkCreateRawInventoryPrice
      );
  
      if (!result.ok) {
        logger.error('Failed to push:', result.errors);
        return null;
      }
  
      return prices.length;
    } catch (e) {
      logger.error('Something went wrong while requesting: ', e);
      return null;
    }
  }
  
  async function complete(sourceId, hash, date = null) {
    logger.info(`Completing the source '${sourceId}' for '${hash}'`);
  
    const data = {
      source: sourceId,
      hash,
      date,
    };
  
    const query = `mutation completeSourceBatch($data: SourceBatchMutationInput!) {
      completeSourceBatch(data: $data) {
        ok
        errors {
          field
          messages
        }
        data {
          id
        }
      }
    }`;
    const response = await client.request(query, { data });
    const result = response.completeSourceBatch;
  
    if (!result.ok) {
      logger.error('Failed to complete:', result.errors);
      return null;
    }
  
    return result.data;
  }
  
  async function createAlarm(sourceId, msg, url) {
    logger.info(`Creating alarm for UI change regarding '${sourceId}'`);
  
    const data = {
      targetId: sourceId,
      type: 'uc',
      date: formatDate(new Date()),
      data: JSON.stringify({
        Description: msg,
        'Detail URL': url,
        'Source ID': sourceId,
      }),
    };
  
    const query = `mutation createAlarm($data: AlarmMutationInput!) {
      createAlarm(data: $data) {
        ok
        errors {
          field
          messages
        }
        data {
          id
        }
      }
    }`;
    const response = await client.request(query, { data });
    const result = response.createAlarm;
  
    if (!result.ok) {
      logger.error('Failed to send alarm:', result.errors);
      return null;
    }
  
    return result.data;
  }
  
  String.prototype.format = function () {
    let i = 0;
    const args = arguments;
    return this.replace(/{\d}/g, () => (typeof args[i] !== 'undefined' ? args[i++] : ''));
  };
  
  String.prototype.capitalizeFirstLetter = function () {
    return this.charAt(0).toUpperCase() + this.slice(1);
  };
  
  // Pusher
  // ======
  
  
  class PricePusher {
    static bufferSize = 100;
  
    constructor(name, defaults, lastMonthOnly, lazy = false, type, source) {
      this.name = name;
      this.defaults = {
        ...defaults,
        language: defaults.language || 'en',
        method: defaults.method || 'a',
      };
      this.lastMonthOnly = lastMonthOnly;
      this.type = type;
      this.source = source;
      this.prices = null;
      this.buffer = [];
      this.count = 0;
      this.hash = randomSha1();
    }
  
  
    async push(prices, force = false) {
      const { source } = this;
      if (!source) {
        logger.error('Source is not set from Pusher Push');
        return;
      }
  
      logger.debug(`Buffering ${prices.length} prices`);
  
      if (this.lastMonthOnly) {
        const monthBefore = lastMonth();
        prices = prices.filter(({ date }) => moment(date) >= monthBefore);
      }
  
      this.count += prices.length;
      if (this.defaults.frequency === 'm') {
        const thresholdDate = moment().subtract(1, 'day').format('YYYY-MM-DD');
        this.buffer = this.buffer.concat(prices.map(({ date, ...props }) => ({
          date: thresholdDate < lastDateOfMonth(date) ? thresholdDate : lastDateOfMonth(date),
          ...props,
        })));
      } else {
        this.buffer = this.buffer.concat(prices);
      }
  
      if (force || this.buffer.length > this.constructor.bufferSize) {
        await this.flush();
      }
    }
  
    async complete(date = null) {
      if (!this.count) {
        logger.warn('Nothing to complete');
        return;
      }
  
      const { source } = this;
      if (!source) {
        logger.error('Source is not set in Pusher Complete');
        return;
      }
  
      await this.flush(source);
      await complete(source.id, this.hash, date);
    }
  
    async flush() {
      const { source } = this;
      if (!source) {
        logger.error('Source is not set from Pusher Flush');
        return;
      }
  
      if (!this.buffer.length) {
        return;
      }
  
      const prices = this.buffer;
      this.buffer = [];
  
      logger.info(`Flushing ${prices.length} buffered prices`);
  
      const size = this.constructor.bufferSize;
      const queue = [];
  
      while (prices.length > 0) {
        queue.push(prices.shift());
        if (!prices.length || queue.length === size) {
          const result = await push(source.id, this.hash, queue, this.type);
          if (result) {
            logger.info('Successfully flushed:', result);
          }
          queue.length = 0;
        }
      }
    }
  }
  
  
  // PriceCrawler
  // =======
  
  
  export class PriceCrawler {
    constructor({
      name,
      defaults,
      queueOptions,
      timezone,
      author = config.authorDefaults,
    }) {
      assert(timezone, 'Timezone is required');
  
      this.name = name;
      this.defaults = defaults;
      this.queueOptions = {
        name: this.name,
        ...queueOptions,
      };
      this.timezone = timezone;
      this.author = author;
      this.type = 'data';
    }
  
    async initialize() {
      this.source = await createOrUpdateSource({
        name: this.name,
        ...this.defaults,
      }, this.type);
    }
  
    async crawl(lastMonthOnly = false) {
      await this.initialize();
      logger.info(`Start crawling ${this.name}`);
  
      const start = new Date();
  
      const pusher = new PricePusher(
        this.name, { ...this.defaults }, lastMonthOnly, false, this.type, this.source,
      );
      const queue = new Queue({
        ...this.queueOptions,
        producerMeta: {
          source: this.source,
          archive: this.archive,
          assert: this.assert,
          ...(this.queueOptions.producerMeta || {}),
        },
        consumerMeta: {
          source: this.source,
          pusher,
          assert: this.assert,
          archive: this.archive,
          ...(this.queueOptions.consumerMeta || {}),
        },
      });
  
      try {
        await queue.run();
      } catch (e) {
        logger.error('Failed to run a queue: ', e);
      }
  
      await pusher.complete();
  
      const {
        count, hash, prices, source,
      } = pusher;
  
      if (config.env === 'prod' && count !== null) {
        const coveredDates = orderBy(uniqBy(prices, 'date').map(({ date }) => date));
        await this.report({
          count,
          source,
          elapsed: new Date() - start,
          dates: coveredDates,
        });
      }
  
      return count;
    }
  
    async assert(conditions, url) {
      let assertMsg = '';
      for (const [condition, message] of conditions) {
        if (!condition) {
          assertMsg += [message, '\n'].join('');
          const { source } = this;
          if (!source) {
            logger.error('Source is not set from Assert');
            return;
          }
          await createAlarm(source.id, assertMsg, url);
        }
      }
      if (assertMsg) {
        logger.warn(`The UI seems to be changed. [${assertMsg}] | ${url}`);
      }
      return !!assertMsg;
    }
  
    async archive(doc, seq = 1, date = null, ext = 'html', version = 1) {
      assert(doc, 'Document is required');
      assert((typeof doc === 'string' || Buffer.isBuffer(doc)),
        'Document type is not String or Buffer in Archive');
      if (config.env !== 'prod') {
        return;
      }
      const today = moment().format('YYYY-MM-DD'); // crawled date
      const file = Buffer.from(doc, 'utf8');
      const key = `archive/crawl-data/${snakeCase(this.pusher.name)}/v${version}/${date ? `${date}/` : ''}${today}/s${seq}.${ext}`;
      await uploadToS3(file, key);
    }
  
    async report(data) {
      const flag = `:flag-${this.defaults.country.toLowerCase()}:`;
      const {
        source, dates, count, elapsed,
      } = data;
  
      const text = (
        !dates.length
          ? `A hash crawler *${this.name} ${source ? `(#${source.id})` : ''}* ${flag} has processed *${formatNumber(count)}* prices, and it took \`${formatDuration(elapsed)}\`.`
          : `A hash crawler *${this.name} ${source ? `(#${source.id})` : ''}* ${flag} has processed *${formatNumber(count)}* prices for *${dates.length === 1 ? dates[0] : `${dates[0]}, ${dates[1]}, ..., ${dates[dates.length - 1]}`}*, and it took \`${formatDuration(elapsed)}\`.`
      );
  
      return sendSlack({
        text,
        attachments: [{
          title: this.name,
          title_link: this.defaults.url,
          text: this.defaults.description,
          fields: [
            {
              title: 'Country',
              value: flag,
              short: true,
            },
            {
              title: 'Currency',
              value: this.defaults.currency,
              short: true,
            },
            {
              title: 'Timezone',
              value: this.timezone,
              short: true,
            },
          ],
        }],
      });
    }
  }
  
  export class PriceDateAwareCrawler extends PriceCrawler {
    constructor({
      name,
      defaults,
      queueOptions,
      timezone,
      author = config.authorDefaults,
      firstDate = '1970-01-01',
      threshold = 14,
      delay = 1000,
      crawlByDateAvailable = false,
    }) {
      super({
        name,
        defaults,
        queueOptions,
        timezone,
        author,
      });
  
      this.type = 'data';
      this.firstDate = firstDate;
      this.threshold = threshold;
      this.delay = delay;
      this.crawlByDateAvailable = crawlByDateAvailable;
    }
  
    async crawlAll(step = 1) {
      await this.crawlRange(this.getYesterday(), this.getFirstDate(), step);
    }
  
    async crawlYesterday() {
      await this.crawl(this.getYesterday());
    }
  
    async crawlLastMonth() {
      await this.crawl(this.getLastMonth());
    }
  
    async crawlLastWeek() {
      await this.crawl(this.getLastWeek());
    }
  
    async crawlRange(start, end, step = 1, threshold = null) {
      assert(
        this.crawlByDateAvailable,
        'This crawler doesn\'t support crawling by date',
      );
  
      start = formatDate(start);
      end = formatDate(end);
      threshold = threshold || this.threshold;
  
      logger.info(`Start crawling ${this.name} from ${start} to ${end}`);
  
      let consecutiveFailureCount = 0;
  
      for (const date of dateRange(start, end, step)) {
        const count = await this.crawl(date);
  
        consecutiveFailureCount = count === 0 ? consecutiveFailureCount + 1 : 0;
  
        logger.debug(
          `Consecutive failure count as of now: ${consecutiveFailureCount}`,
        );
  
        if (threshold && consecutiveFailureCount > threshold) {
          logger.warn(`Failed more than ${threshold} times, so stopping here`);
          break;
        }
  
        count !== null && await delay(this.delay);
      }
    }
  
    async getObjectListFromS3(pageDate = null, ext = 'html', version = 1) {
      const responseArray = [];
  
      const getObject = async (key) => {
        const responseItem = await getObjectFromS3(key);
        if (responseItem && responseItem.Body) {
          if (ext === 'html') {
            responseArray.push(responseItem.Body.toString('utf-8'));
          } else {
            responseArray.push(responseItem.Body);
          }
        }
      };
  
      const generator = s3tree({ bucket: config.s3BucketName });
      const tree = await generator.generate(`/archive/crawl-data/${snakeCase(this.pusher.name)}/v${version}/${pageDate}`);
      const latestDate = Object.keys(tree).sort().reverse()[0];
  
      if (latestDate && latestDate.slice(0, 1) === 's') {
        const keys = Object.values(tree);
        await Promise.allSettled(
          keys.map(key => getObject(key)),
        ).then();
      } else if (latestDate) {
        const fileObj = tree[latestDate];
        const keys = Object.values(fileObj);
        await Promise.allSettled(
          keys.map(key => getObject(key)),
        ).then();
      }
  
      return responseArray;
    }
  
    async crawl(date, ...args) {
      await this.initialize();
      const start = new Date();
  
      const pusher = await this.doCrawl(date);
  
      const { count, prices, source } = pusher;
  
      if (config.env === 'prod' && count !== null) {
        const coveredDates = orderBy(uniqBy(prices, 'date').map(({ date }) => date));
        await this.report({
          count,
          source,
          elapsed: new Date() - start,
          date: formatDate(date),
          dates: coveredDates,
        });
      }
  
      return count;
    }
  
    async doCrawl(date) {
      date = formatDate(date);
  
      logger.info(`Start crawling ${this.name} for ${date}`);
  
      const pusher = new PricePusher(
        this.name, this.defaults, false, false, this.type, this.source
      );
      const queue = new Queue({
        ...this.queueOptions,
        producerMeta: {
          source: this.source,
          date,
          pusher,
          assert: this.assert,
          getObjectListFromS3: this.getObjectListFromS3,
          archive: this.archive,
          ...(this.queueOptions.producerMeta || {}),
        },
        consumerMeta: {
          source: this.source,
          date,
          pusher,
          assert: this.assert,
          archive: this.archive,
          ...(this.queueOptions.consumerMeta || {}),
        },
      });
  
      try {
        await queue.run();
      } catch (e) {
        logger.error('Failed to run a queue: ', e);
      }
  
      await pusher.complete(date);
  
      return pusher;
    }
  
    getFirstDate() {
      return this.firstDate;
    }
  
    getLastMonth() {
      return lastMonth(this.timezone);
    }
  
    getLastWeek() {
      return lastWeek(this.timezone);
    }
  
    getYesterday() {
      return yesterday(this.timezone);
    }
  
    async report(data) {
      const flag = `:flag-${this.defaults.country.toLowerCase()}:`;
  
      const {
        source, count, elapsed, date, dates,
      } = data;
  
      const text = (
        !dates.length
          ? `A crawler *${this.name} ${source ? `(#${source.id})` : ''}* ${flag} has processed *${formatNumber(count)}* *${this.type === 'merchandise' ? 'retail' : 'wholesale'}* prices for *${date}*, and it took \`${formatDuration(data.elapsed)}\`.`
          : `A crawler *${this.name} ${source ? `(#${source.id})` : ''}* ${flag} has processed *${formatNumber(count)}* *${this.type === 'merchandise' ? 'retail' : 'wholesale'}* prices for *${date}* and actual date coverage was ${dates.length > 1 ? `${dates[0]} ~ ${dates[dates.length - 1]}` : `${dates[0]}`}, it took \`${formatDuration(elapsed)}\`.`
      );
  
      return sendSlack({
        text,
        attachments: [{
          title: this.name,
          title_link: this.defaults.url,
          text: this.defaults.description,
          fields: [
            {
              title: 'Country',
              value: flag,
              short: true,
            },
            {
              title: 'Currency',
              value: this.defaults.currency,
              short: true,
            },
            {
              title: 'Timezone',
              value: this.timezone,
              short: true,
            },
          ],
        }],
      });
    }
  }
  
  export class PriceMerchandiseCrawler extends PriceDateAwareCrawler {
    constructor(...args) {
      super(...args);
      this.type = 'merchandise';
    }
  }
  
  export class Price {
    constructor(initialValues = {}) {
      const {
        priceMin,
        priceAvg,
        priceMax,
        product,
        region,
        country,
        pageUrl,
        currency,
        date,
        type,
        unit,
        grade,
      } = initialValues;
      this.prices = {
        priceMin,
        priceAvg,
        priceMax,
      };
      this.product = product;
      this.region = region;
      this.country = country;
      this.pageUrl = pageUrl;
      this.currency = currency;
      this.date = date;
      this.type = type;
      this.unit = unit;
      this.grade = grade;
  
      this.mandatoryPropertyNames = [
        'product',
        'country',
        'date',
        'type',
        'pageUrl',
        'unit',
        'currency',
        'prices',
      ];
      this.optionalPropertyNames = [
        'region',
        'grade',
        'variety',
        'origin',
      ];
    }
  
    log(...args) {
      debugLog.log(...args);
    }
  
    getData() {
      return {
        ...this.getPrices(),
        product: this.getProduct(),
        country: this.getCountry(),
        pageUrl: this.getPageUrl(),
        currency: this.getCurrency(),
        date: this.getDate(),
        type: this.getType(),
        unit: this.getUnit(),
        ...this.getRegion() ? { region: this.getRegion() } : {},
        ...this.getGrade() ? { grade: this.getGrade() } : {},
        ...this.getOrigin() ? { origin: this.getOrigin() } : {},
        ...this.getVariety() ? { variety: this.getVariety() } : {},
      };
    }
  
    isValidProduct(product) {
      const wordRegExp = /[\s\S]+/g;
      return typeof product === 'string'
        && product.length > 0
        && wordRegExp.test(product);
    }
  
    setProduct(product) {
      this.product = product;
    }
  
    isValidDate(date) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      const currentDate = moment();
      const momentDate = moment(date, 'YYYY-MM-DD');
      const relevantDate = moment('1990-01-01', 'YYYY-MM-DD');
      const isString = typeof date === 'string';
      const isValidDateFormat = isString && dateRegex.test(date);
      const isValidDate = isValidDateFormat && momentDate.isValid();
      const isPastDate = isValidDate && momentDate.isBefore(currentDate);
      const isRelevantDate = momentDate.isAfter(relevantDate);
      const isValid = (isString && isValidDateFormat && isValidDate)
        && (isPastDate && isRelevantDate);
  
      return {
        isValid,
        messages: [
          ...!isString
            ? ['Date is not a string']
            : !isValidDateFormat
              ? [`Date format is wrong: ${date}`]
              : !isValidDate
                ? [`Date is invalid: ${date}`]
                : !isPastDate
                  ? [`Date must be a prior to today's date: ${date}`]
                  : !isRelevantDate
                    ? [`Date must be a past 1990-01-01: ${date}`]
                    : [],
        ],
      };
    }
  
    // meta
    setDate(date) {
      this.date = date;
    }
  
    isValidType(type) {
      return typeof type === 'string' && type.length === 1;
    }
  
    setType(type) {
      this.type = type;
    }
  
    isValidPageUrl(pageUrl) {
      return typeof pageUrl === 'string' && isValidUrl(pageUrl);
    }
  
    setPageUrl(url) {
      this.pageUrl = url;
    }
  
    isValidUnit(unit) {
      return typeof unit === 'string';
    }
  
    // prices
    setUnit(unit) {
      this.unit = unit;
    }
  
    setPriceAvg(price) {
      this.prices.priceAvg = price;
    }
  
    setPriceMin(price) {
      this.prices.priceMin = price;
    }
  
    setPriceMax(price) {
      this.prices.priceMax = price;
    }
  
    isValidCurrency(currency) {
      return typeof currency === 'string' && currency.length === 3;
    }
  
    setCurrency(currency) {
      this.currency = currency;
    }
  
    isValidCountry(country) {
      return typeof country === 'string' && country.length === 2;
    }
  
    // geography
    setCountry(country) {
      this.country = country;
    }
  
    isValidRegion(region) {
      return typeof region === 'string';
    }
  
    setRegion(region) {
      this.region = region;
    }
  
    isValidGrade(grade) {
      return typeof grade === 'string';
    }
  
    // attributes
    setGrade(grade) {
      this.grade = grade;
    }
  
    isValidVariety(variety) {
      return typeof variety === 'string';
    }
  
    setVariety(variety) {
      this.variety = variety;
    }
  
    isValidOrigin(origin) {
      return typeof origin === 'string';
    }
  
    setOrigin(origin) {
      this.origin = origin;
    }
  
    isValid() {
      const isPriceValid = this.mandatoryPropertyNames.every((name) => {
        const getterFunctionName = `get${capitalize(name)}`;
        const validationFunctionName = `isValid${capitalize(name)}`;
        const isFunctionDefined = isFunction(this[getterFunctionName]);
        const value = isFunctionDefined
          ? this[getterFunctionName]()
          : undefined;
        const hasValue = !!value;
        const validationValue = this[validationFunctionName](value);
        const isValidField = isFunctionDefined
          && hasValue
          && (isObject(validationValue)
            ? validationValue.isValid
            : validationValue);
  
        if (!isValidField) {
          if (isObject(validationValue) && validationValue.messages.length) {
            debugLog.log('\n');
            debugLog.error('Invalid field');
            debugLog.table(validationValue.messages);
          } else {
            debugLog.error('Invalid field');
            debugLog.table({
              getterFunctionName,
              isFunctionDefined,
              hasValue,
              validValid: hasValue ? false : '-',
            });
          }
        }
        return isValidField;
      });
      if (isPriceValid) {
        debugLog.success('VALID PRICE');
      }
      return isPriceValid;
    }
  
    isValidPrice(price) {
      return (isNumber(price) || /^(\.*[0-9])+$/.test(price))
        && (Number(price) > 0)
        && !Number.isNaN(Number(price));
    }
  
    isValidPrices(prices) {
      const { priceAvg, priceMin, priceMax } = prices;
      const isValidAvgPrice = this.isValidPrice(priceAvg);
      const isValidMinPrice = this.isValidPrice(priceMin);
      const isValidMaxPrice = this.isValidPrice(priceMax);
      const isAnyPriceValid = isValidAvgPrice
        || (isValidMinPrice && isValidMaxPrice);
      return {
        isValid: isAnyPriceValid,
        messages: !isAnyPriceValid
          ? [
            ...!isValidAvgPrice ? [`Invalid priceAvg: [${priceAvg}] `] : [],
            ...!isValidMinPrice ? [`Invalid priceMin: [${priceMin}]`] : [],
            ...!isValidMaxPrice ? [`Invalid priceMax: [${priceMax}]`] : [],
          ]
          : [],
      };
    }
  
    getPrices() {
      const prices = {};
      const { priceMin, priceMax, priceAvg } = this.prices;
      if (this.isValidPrice(priceAvg)) {
        prices.priceAvg = priceAvg;
      }
      if (this.isValidPrice(priceMin) && this.isValidPrice(priceMax)) {
        prices.priceMin = priceMin;
        prices.priceMax = priceMax;
      }
      return prices;
    }
  
    getPriceAvg() {
      return this.getValidPrices()?.priceAvg || this.prices.priceAvg;
    }
  
    getPriceMin() {
      return this.getValidPrices()?.priceMin || this.prices.priceMin;
    }
  
    getPriceMax() {
      return this.getValidPrices()?.priceMax || this.prices.priceMax;
    }
  
    getAttributes() {
      return {
        grade: this.getGrade(),
        variety: this.getVariety(),
        origin: this.getOrigin(),
      };
    }
  
    getGrade() {
      return this.grade || this.initialValues.grade;
    }
  
    getVariety() {
      return this.variety || this.initialValues.variety;
    }
  
    getOrigin() {
      return this.origin || this.initialValues.origin;
    }
  
    getGeoData() {
      return {
        region: this.getRegion(),
        country: this.getCountry(),
      };
    }
  
    getMetaData() {
      return {
        date: this.getDate(),
        type: this.getType(),
        pageUrl: this.getPageUrl(),
      };
    }
  
    getPriceData() {
      return {
        ...this.prices,
        unit: this.getUnit(),
        currency: this.getCurrency(),
      };
    }
  
    getProduct() {
      return this.product || this.initialValues.product;
    }
  
    getCountry() {
      return this.country || this.initialValues.country;
    }
  
    getRegion() {
      return this.region || this.initialValues.region;
    }
  
    getDate() {
      return this.date || this.initialValues.date;
    }
  
    getPageUrl() {
      return this.pageUrl || this.initialValues.pageUrl;
    }
  
    getUnit() {
      return this.unit || this.initialValues.unit;
    }
  
    getType() {
      return this.type || this.initialValues.type;
    }
  
    getCurrency() {
      return this.currency || this.initialValues.currency;
    }
  
    getMissingFields() {
      const propertyNames = [
        ...this.mandatoryPropertyNames,
        ...this.optionalPropertyNames,
      ];
      const missingFields = [];
      propertyNames.forEach((propertyName) => {
        const isValueUndefined = !this[`get${capitalize(propertyName)}`]();
        if (isValueUndefined) {
          missingFields.push(propertyName);
        }
      });
      return missingFields;
    }
  
    getMissingRequiredFields() {
      const missingFields = [];
      this.mandatoryPropertyNames.forEach((propertyName) => {
        const isValueUndefined = !this[`get${capitalize(propertyName)}`]();
        if (isValueUndefined) {
          missingFields.push(propertyName);
        }
      });
      return missingFields;
    }
  
    getDefinedFields() {
      const definedFields = [];
      const propertyNames = [
        ...this.mandatoryPropertyNames,
        ...this.optionalPropertyNames,
      ];
      propertyNames.forEach((propertyName) => {
        const value = this[`get${capitalize(propertyName)}`]();
        const isValueDefined = !!value;
        if (isValueDefined) {
          definedFields.push(propertyName);
        }
      });
      return definedFields;
    }
  
    getDefinedRequiredFields() {
      const definedFields = [];
      this.mandatoryPropertyNames.forEach((propertyName) => {
        const value = this[`get${capitalize(propertyName)}`]();
        const isValueDefined = !!value;
        if (isValueDefined) {
          definedFields.push(propertyName);
        }
      });
      return definedFields;
    }
  
    getDefinedFieldValues() {
      const definedFieldByName = {};
      const propertyNames = [
        ...this.mandatoryPropertyNames,
        ...this.optionalPropertyNames,
      ];
      propertyNames.forEach((propertyName) => {
        const value = this[`get${capitalize(propertyName)}`]();
        const isValueDefined = !!value;
        if (isValueDefined) {
          definedFieldByName[propertyName] = value;
        }
      });
      return definedFieldByName;
    }
  
    getDefinedRequiredFieldValues() {
      const definedFieldByName = {};
      this.mandatoryPropertyNames.forEach((propertyName) => {
        const value = this[`get${capitalize(propertyName)}`]();
        const isValueDefined = !!value;
        if (isValueDefined) {
          definedFieldByName[propertyName] = value;
        }
      });
      return definedFieldByName;
    }
  
    getInvalidFields() {
      // TO IMPLEMENT
    }
  
    logRawData() {
      const {
        product,
        currency,
        country,
        date,
        type,
        pageUrl,
        unit,
        region,
        grade,
        variety,
        prices: {
          priceAvg,
          priceMin,
          priceMax,
        },
      } = this;
      const priceKeyValuePairs = Object.entries({
        product,
        currency,
        country,
        date,
        type,
        page_url: pageUrl,
        unit,
        region,
        grade,
        variety,
        priceAvg,
        priceMin,
        priceMax,
      });
  
      const noData = debugLog.printError('✘');
      debugLog.log('\n');
  
      priceKeyValuePairs.forEach((keyValuePair) => {
        const [key, value] = keyValuePair;
        const formatedKey = padString(capitalize(key), 15);
        const styledFormatedKey = value
          ? formatedKey
          : debugLog.printWarn(formatedKey);
        debugLog.log(`${styledFormatedKey} ${value || noData}`);
      });
    }
  
    logData() {
      const {
        product,
        currency,
        country,
        date,
        type,
        pageUrl,
        unit,
        region,
        grade,
        variety,
        priceAvg,
        priceMin,
        priceMax,
      } = this.getData();
  
      const priceKeyValuePairs = Object.entries({
        product,
        currency,
        country,
        date,
        type,
        page_url: pageUrl,
        unit,
        region,
        grade,
        variety,
        price_avg: priceAvg,
        price_min: priceMin,
        price_max: priceMax,
      });
      const noData = debugLog.printError('✘');
      debugLog.log('\n');
  
      priceKeyValuePairs.forEach((keyValuePair) => {
        const [key, value] = keyValuePair;
        const formatedKey = padString(capitalize(key), 15);
        const styledFormatedKey = value
          ? formatedKey
          : debugLog.printWarn(formatedKey);
        debugLog.log(`${styledFormatedKey} ${value || noData}`);
      });
    }
  }
  
  Price.prototype.initialValues = {};
  Price.setInitialValues = function setInitialValues(initialValues) {
    Price.prototype.initialValues = initialValues;
  };
  