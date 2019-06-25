#!/usr/bin/env node
let fs = require('fs-extra')
let request = require('request-promise-native')
let {StatusCodeError,RequestError} = require('request-promise-native/errors')
let sanitizeFilename = require('sanitize-filename')
let colors = require('colors')
let util = require('util')
let path = require('path')

let config = require('./config.js')
let lib = require('./src/lib.js')
let template = require('./src/template.js')
let renderPageText = require('./src/render-page-text.js')

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
           default: ['arbital_front_page'] })
         .option('recursive', {
           desc: 'download recursively',
           boolean: true,
           default: false })
         .option('timeout', {
           desc: 'timeout (ms) per page',
           number: true,
           default: 7000 })
         .option('cache-only', {
           desc: 'make no http requests',
           boolean: true,
           default: false }))
  .help()
  .argv

let CacheOnlyError = class extends Error {constructor(){super('--cache-only enabled');this.name = 'CacheOnlyError'}}

const PageStatus_aliasOrId = 1
const PageStatus_pageRef   = 2
const PageStatus_page      = 3

let Page
let PageRef = class {
  constructor(aliasOrIdOrPartialPageJson, status=PageStatus_pageRef) {
    this.cached = false
    if (typeof(aliasOrIdOrPartialPageJson) == "string") {
      this._copyProperties(PageStatus_aliasOrId, { aliasOrId: aliasOrIdOrPartialPageJson })
    } else {
      this._copyProperties(status, aliasOrIdOrPartialPageJson)
    }
  }

  _copyProperties(status, p) {
    this.status = status
    this.partialPageJson = p
    this.pageId = p.pageId
    this.alias = p.alias
    this.aliasOrId = this.alias || this.pageId || p.aliasOrId
    this.keys = Array.from(new Set([this.aliasOrId, this.pageId, this.alias]))
    this.title = p.title
    this.text = p.text
    this.clickbait = p.clickbait
    this.name = this.title
      || (this.clickbait && this.clickbait.substring(config.textToNameMaxLength))
      || (this.text && this.text.substring(config.textToNameMaxLength))
      || this.aliasOrId
    this.arbitalUrl = `https://arbital.com/p/${this.aliasOrId}`
  }

  async _requestRawPage() {
    if (argv['cache-only']) throw new CacheOnlyError()
    let url = `${argv.url}/json/primaryPage/`
    let body = { pageAlias: this.aliasOrId }
    this.log('fetching', 'POST', url, body)
    return await request({
      method: 'POST',
      url: url,
      json: true,
      body: body,
      timeout: argv.timeout })
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

  pickBest(...others) { return lib.maxBy([this].concat(others).filter(p=>p), p=>p.status) }
}

let findPageInRawPageJson = (aliasOrId, rawPageJson)=> rawPageJson.pages[aliasOrId] || Object.values(rawPageJson.pages).find(p=>p.alias==aliasOrId)
let isArbitalPageIdField = k=>k !='analyticsId' && (['individualLikes'].includes(k) || k.endsWith('Ids') || k.endsWith('Id'))

Page = class extends PageRef {
  constructor(aliasOrId, rawPageJson) {
    super(findPageInRawPageJson(aliasOrId, rawPageJson), PageStatus_page)
    this.rawPageJson = rawPageJson
    this.pageJson = this.partialPageJson
  }

  async _filename(subdir, name) { return `${argv.directory}/${subdir}/${sanitizeFilename(name)}` }

  async _writeFile(subdir, name, json) {
    let file = await this._filename(subdir, name)
    this.log('writing', file)
    await fs.mkdirp(path.dirname(file))
    await fs.writeFile(file, json)
    return file
  }

  async _writeJson(subdir, name, json) {
    let file = await this._filename(subdir, name)
    this.log('writing', file)
    await fs.mkdirp(path.dirname(file))
    await fs.writeJson(file, json, {spaces: 2})
    return file
  }

  _renderPage() { return template.page({...this, textHtml: renderPageText(this)}) }

  async saveRaw() { if (!this.cached) await this._writeJson('raw', `${this.pageId}.json`, this.rawPageJson) }

  async saveHtml() { await this._writeFile('page', `${this.aliasOrId}.html`, this._renderPage()) }

  findPageRefs() {
    let walkJson = (json, func, key='')=>{
      if (json instanceof Array) {
        json.forEach(v=>walkJson(v, func, key))
      } else if (json instanceof Object) {
        Object.keys(json).forEach(k=>walkJson(json[k], func, k))
      } else {
        func(key, json)
      }
    }

    return this._pageRefs = this._pageRefs || (()=>{
      let pageRefs = Object.values(this.rawPageJson.pages).map(p=>new PageRef(p))
      walkJson(this.rawPageJson, (k,v)=> { if (isArbitalPageIdField(k) && v) pageRefs.push(new PageRef(v)) })
      return pageRefs
    })()
  }
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
  let lastFetchFailures = lastScrapeMetadata.fetchFailures || {}

  let toDownload = Array.from(argv.page.map(p=>new PageRef(p)))
  let pageIndex = {}
  let fetchFailures = {}

  if (argv.recursive) {
    let rawDir = `${argv.directory}/raw`
    let cachedPageFiles = await util.promisify(fs.readdir)(rawDir)
    cachedPageFiles.forEach(f=>{ if (f.endsWith('.json')) toDownload.push(new PageRef(f.replace(/\.json$/, ''))) })
  }

  let addToIndex =p=>{
    p = pageIndex[p.aliasOrId.toLowerCase()] = pageIndex[p.aliasOrId] = pageIndex[p.aliasOrId] ? pageIndex[p.aliasOrId].pickBest(p) : p
    if (p.alias && p.pageId) aliasToId[p.alias] = p.pageId
    if (p.pageId) { pageIndex[p.pageId] = p; pageIndex[p.pageId.toLowerCase()] = p }
    if (p.alias) { pageIndex[p.alias] = p; pageIndex[p.alias.toLowerCase()] = p }
  }
  toDownload.forEach(addToIndex)

  while (toDownload.length > 0) {
    let pageRef = toDownload.pop()
    pageRef = pageRef.pickBest(...pageRef.keys.map(k=>pageIndex[k]))

    if (pageRef.status == PageStatus_page) continue
    if (pageRef.keys.some(k=>fetchFailures[k])) continue

    let page
    try { page = await pageRef.requestCachedPage(aliasToId) } catch (e) {
      if (e instanceof StatusCodeError || e instanceof RequestError || e instanceof CacheOnlyError) {
        let lastError = lastFetchFailures[pageRef.aliasOrId]
        if (e instanceof CacheOnlyError && lastError && lastError.name != 'CacheOnlyError') e = lastError
        pageRef.log(colors.red('failed'), e.message)
        fetchFailures[pageRef.aliasOrId] = e
        continue
      } else throw e
    }

    await page.saveRaw()

    addToIndex(page)
    let subPageRefs = page.findPageRefs()
    subPageRefs.forEach(addToIndex)
    if (argv.recursive) toDownload.push(...subPageRefs)
  }

  let newFetchFailures = {...lastFetchFailures, ...fetchFailures}
  for (let aliasOrId of Object.keys(newFetchFailures)) {
    if (pageIndex[aliasOrId] && pageIndex[aliasOrId].status == PageStatus_page)
      delete newFetchFailures[aliasOrId]
  }
  let scrapeMetadata = {aliasToId:aliasToId, fetchFailures:newFetchFailures}
  console.log('writing', scrapeMetadataFile)
  await fs.writeJson(scrapeMetadataFile, scrapeMetadata)

  let savedHtml = new Set()
  for (let page of Object.values(pageIndex)) {
    if (page.status == PageStatus_page && !savedHtml.has(page.pageId)) {
      savedHtml.add(page.pageId)
      await page.saveHtml()
    }
  }

  let copyFile = async (source,destination,content)=>{
    console.log('copying', source, 'to', destination)
    await fs.copyFile(source, destination)
  }

  await copyFile('template/page-style.css', `${argv.directory}/page-style.css`)

  if (Object.keys(fetchFailures).length > 0) {
    console.log('')
    console.log('Fetch failures:')
    for (let aliasOrId of Object.keys(fetchFailures)) {
      let error = fetchFailures[aliasOrId]
      pageIndex[aliasOrId].log(colors.red('failed'), error.message)
    }
  }
})()
