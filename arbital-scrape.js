#!/usr/bin/env node
let fs = require('fs-extra')
let request = require('request-promise-native')
let sanitizeFilename = require('sanitize-filename')
let util = require('util')
let path = require('path')

let argv = require('yargs')
  .command('$0 [directory]', 'scrape arbital.com restartable', yargs=>
    yargs.positional('directory', {
           desc: 'destination directory',
           string: true,
           default: 'arbital.com' })
         .option('url', {
           desc: 'arbital url',
           default: 'https://arbital.com' })
         .option('page', {
           desc: 'pages to download or start at',
           array: true,
           string: true,
           default: ['arbital_front_page'] }))
  .help()
  .argv

let Page
let PageRef = class {
  constructor(aliasOrIdOrPartialPageJson) {
    this.cached = false
    if (typeof(aliasOrIdOrPartialPageJson) == "string") {
      this._copyProperties({ aliasOrId: aliasOrIdOrPartialPageJson })
    } else {
      this._copyProperties(aliasOrIdOrPartialPageJson)
    }
  }

  _copyProperties(p) {
    this.partialPageJson = p
    this.pageId = p.pageId
    this.alias = p.alias
    this.aliasOrId = this.alias || this.pageId || p.aliasOrId
    this.title = p.title
  }

  async _requestRawPage() {
    let url = `${argv.url}/json/primaryPage/`
    let body = { pageAlias: this.aliasOrId }
    this.log('fetching', 'POST', url, body)
    return await request({
      method: 'POST',
      url: url,
      json: true,
      body: body })
  }

  async requestCachedPage(aliasToId) {
    let id = this.pageId || aliasToId[this.aliasOrId] || this.aliasOrId
    let file = `${argv.directory}/raw/${sanitizeFilename(id)}.json`
    if (await fs.pathExists(file)) {
      let r = new Page(id, await fs.readJson(file))
      this.log('found cached', file)
      r.cached = true
      return r
    }
    return new Page(id, await this._requestRawPage())
  }

  log(command, ...args) { console.log(command, this.aliasOrId, util.inspect(this.title || ''), ...args) }
}

let findPageInRawPageJson = (aliasOrId, rawPageJson)=> rawPageJson.pages[aliasOrId] || Object.values(rawPageJson.pages).find(p=>p.alias==aliasOrId)

Page = class extends PageRef {
  constructor(aliasOrId, rawPageJson) {
    super(findPageInRawPageJson(aliasOrId, rawPageJson))
    this.rawPageJson = rawPageJson
    this.pageJson = this.partialPageJson
  }

  async _filename(subdir, name) { return `${argv.directory}/${subdir}/${sanitizeFilename(name)}` }

  async _writeJson(subdir, name, json) {
    let file = await this._filename(subdir, name)
    this.log('writing', file)
    await fs.mkdirp(path.dirname(file))
    await fs.writeJson(file, json, {spaces: 2})
    return file
  }

  async save() { if (!this.cached) await this._writeJson('raw', `${this.pageId}.json`, this.rawPageJson) }
}

;(async ()=>{
  await fs.mkdirp(argv.directory)

  let scrapeMetadataFile = `${argv.directory}/metadata.json`
  let lastScrapeMetadata = {}
  if (await fs.pathExists(scrapeMetadataFile)) {
    console.log('reading', scrapeMetadataFile)
    lastScrapeMetadata = await fs.readJson(scrapeMetadataFile)
  }
  let aliasToId = lastScrapeMetadata.aliasToId || {}

  let toDownload = Array.from(argv.page)
  while (toDownload.length > 0) {
    let pageRef = new PageRef(toDownload.pop())

    let page = await pageRef.requestCachedPage(aliasToId)
    await page.save()
    if (page.alias) aliasToId[page.alias] = page.pageId
  }

  let scrapeMetadata = {aliasToId: aliasToId}
  console.log('writing', scrapeMetadataFile)
  await fs.writeJson(scrapeMetadataFile, scrapeMetadata)
})()
