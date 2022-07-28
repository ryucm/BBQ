
import request from 'request-promise';
import * as cheerio from 'cheerio';


import {
  Producer,
  Consumer,
} from '../../lib/jobs';
import { Crawler } from '../../lib/crawler'


const baseUrl = 'http://mahagrid.com';
class MahagridProducer extends Producer {
  async produce() {
    this.info('Start produce');
    let pageNum = this.constructor.pageStart;
    let pageNation = true;
    while(pageNation) {
      const pageUrl = `/product/list.html?cate_no=24&page=${pageNum}`;
      const url = baseUrl+pageUrl;
      pageNation = await this.fetch(url);
      pageNum += this.constructor.pageStep;
      if (this.constructor.pageMax >= 0
        && pageNum > this.constructor.pageMax) {
        break;
      }
    }
    this.info('Finish produce');
  }

  async fetch(url) {
    let response;
    try {
      response = await request(url);
      this.debug(`producing : ${url}`);
    } catch (e) {
      this.error(e);
      return false;
    }
    const $ = cheerio.load(response);
    $('.mun-prd-thumb > a').each((_i,el) => {
      const parseUrl = $(el).attr('href');
      const url = baseUrl + parseUrl;
      this.push(url);
    })
    return true;
  }
}

class MahagridConsumer extends Consumer {
  async consume(url) {
    let response;
    this.info(`consuming ${url}`);
    try {
      response = await request(url);
    } catch (e) {
      this.debug(`Fail to request ${e}`)
      return;
    }
    const $ = cheerio.load(response);
    const rawData = [];
    $('.mun-detail-desc > span').each((_i,el) => {
      rawData.push($(el).text().trim());;
    })
    const [itemName, productName, price, salePrice] = rawData;
    const imageUrl = `http:${$('.mun-addimg-big img').attr('src')}`;
    const color = $('[option_title="COLOR"] span').text().trim();
    // const inform = 
    const entries = [];
    const entry = {
      itemName,
      productName,
      price,
      salePrice,
      imageUrl,
      url,
      color,
      // size
      // inform,
    }
    entries.push(entry);
    this.meta.pusher.push(entries);
    this.info('Finish consume');
  }
}

export default new Crawler({
  name: 'Maha Grid',
  defaults: {
    description: 'Maha Grid',
    url: 'http://mahagrid.com',
    country: 'kr',
    currency: 'W',
    language: 'kr',
  },
  queueOptions: {
    producer: MahagridProducer,
    consumer: MahagridConsumer,
    producerCount: 1,
    consumerCount: 1,
    // browserOptions: {
    //   headless: true,
    // }
  }
});