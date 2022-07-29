import cheerio from 'cheerio';
import request from 'request-promise';
import moment from 'moment';

import { Producer, Consumer } from 'lib/job';
import { PriceCrawler } from 'lib/price';
import { isValidEntry } from 'lib/util';

// release note URI: https://www.notion.so/tridge/Tapm-2d2a8d3070824b2491e6165c81634d21
const baseUrl = 'http://www.tapmc.com.taipei/Pages/Index';
class TaipeiAgriculturalProducer extends Producer {
  async produce() {
    this.push({});
  }
}

class TaipeiAgriculturalConsumer extends Consumer {
  async consume() {
    let response;
    try {
      response = await request(baseUrl);
    } catch (e) {
      this.warn(e);
    }
    const $ = cheerio.load(response);

    // archive
    await this.meta.archive(response, 1);


    const today = $('.today-day').text().trim();
    const isHoliday = $('.selected-day.seletected-today-day').length;
    const [year, month] = $('table .title td').eq(1).text().match(/\d+/g);
    const date = moment(`${year}-${month}-${today}`, 'YYYY-M-D').format('YYYY-MM-DD');
    if (isHoliday) {
      this.info('Today is holiday.');
      return;
    }
    const rawTitle = [];
    $('.price-head > div').each((_i, el) => rawTitle.push($(el).text()));

    // UI alarm
    const [productCol, valueCol, priceMaxCol, priceAvgCol, priceMinCol] = rawTitle;

    await this.meta.assert([
      [productCol === '品名', `品名 -> ${productCol}`],
      [valueCol === '品種', `品種 -> ${valueCol}`],
      [priceMaxCol === '上價', `上價 -> ${priceMaxCol}`],
      [priceAvgCol === '中價', `中價 -> ${priceAvgCol}`],
      [priceMinCol === '下價', `下價 -> ${priceMinCol}`],
    ], baseUrl);

    // parse
    const productColIndex = rawTitle.indexOf('品名');
    const valueColIndex = rawTitle.indexOf('品種');
    const priceMaxColIndex = rawTitle.indexOf('上價');
    const priceAvgColIndex = rawTitle.indexOf('中價');
    const priceMinColIndex = rawTitle.indexOf('下價');

    const entries = [];
    $('.price-table tbody tr').each((_i, el) => {
      const tableRawData = $(el).find('td');
      const product = tableRawData.eq(productColIndex).text();
      const variety = tableRawData.eq(valueColIndex).text();
      const priceMax = tableRawData.eq(priceMaxColIndex).text();
      const priceAvg = tableRawData.eq(priceAvgColIndex).text();
      const rawPriceMin = tableRawData.eq(priceMinColIndex).text();
      const priceMin = (Number(rawPriceMin) > 0)
        ? rawPriceMin : Math.min(priceAvg, priceMax);
      const entry = {
        date,
        priceMax,
        priceAvg,
        priceMin,
        product,
        variety,
        currency: 'CNY',
        country: 'TW',
        pageUrl: baseUrl,
        region: 'Taipei',
        unit: 'kg',
        type: 'w',
      };

      if (isValidEntry(entry)) {
        entries.push(entry);
      }
    });
    await this.meta.pusher.push(entries);
  }
}

export default new PriceCrawler({
  name: 'Tapm',
  defaults: {
    description: 'Taipei Agricultural Products Marketing',
    url: 'http://www.tapmc.com.taipei/Pages/Index',
    country: 'TW',
    language: 'zh',
    currency: 'CNY',
    frequency: 'd',
    isHistorySupported: false,
  },
  author: {
    name: 'Eden Ryu',
    phone: '010-2552-4364',
  },
  queueOptions: {
    producer: TaipeiAgriculturalProducer,
    consumer: TaipeiAgriculturalConsumer,
    producerCount: 1,
    consumerCount: 1,
  },
  timezone: 'Asia/Taiwan',
});
