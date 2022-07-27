
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
  }

  async fetch(url) {
    let response;
    try {
      response = await request(url);
      console.log(`producing : ${url}`);
    } catch (e) {
      console.log(e);
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
    console.log(`consuming ${url}`);
    this.meta.pusher.push(url);
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