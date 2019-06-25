#!/usr/bin/env node
let fs = require('fs-extra')
let request = require('request-promise-native')
let {StatusCodeError,RequestError} = require('request-promise-native/errors')
let sanitizeFilename = require('sanitize-filename')
let colors = require('colors')
let util = require('util')
let path = require('path')
let Zip = require('adm-zip')
let escapeHtml = require('escape-html')
let flatMap = require('array.prototype.flatmap')

let config = require('./config.js')
let lib = require('./src/lib.js')
let template = require('./src/template.js')
let renderPageText = require('./src/render-page-text.js')
let renderPageLinks = require('./src/render-page-links.js')

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
    this.type = p.type || config.defaultTypeString
    this.title = p.title
    this.text = p.text
    this.clickbait = p.clickbait
    this.name = this.title
      || (this.clickbait && this.clickbait.substring(config.textToNameMaxLength))
      || (this.text && this.text.substring(config.textToNameMaxLength))
      || this.aliasOrId
    this.named = config.namelikePageIds.includes(this.name) || this.title || this.clickbait || this.text || this.alias
    this.arbitalUrl = `https://arbital.com/p/${this.aliasOrId}`
    this.pageCreatedAt = p.pageCreatedAt && new Date(p.pageCreatedAt)
    this.editCreatedAt = p.editCreatedAt && new Date(p.editCreatedAt)
    this.childIds = p.childIds || []
    this.parentIds = p.parentIds || []
    this.pageCreatorId = p.pageCreatorId
    this.creatorIds = p.creatorIds || []
    this.editorIds = this.creatorIds.filter(i=>i!=this.pageCreatorId)
    this.tagIds = p.tagIds || []
    this.individualLikes = p.individualLikes || []
    this.relatedIds = p.relatedIds || []

    this.missingLinks = []
    this.latexStrings = []
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

  renderSummary(pageIndex) {
    if (typeof(this.summary) != "undefined") return this.summary
    let summary = this.clickbait || ''
    if (!summary && this.text) {
      let match = this.text.match(/\[summary(\([^\)]&\))?:/)
      let text = match ? this.text.substring(match.index + match[0].length) : this.text
      summary = renderPageLinks(text, pageIndex, /*missingLinks=*/new Set(), /*textOnly=*/true)
      if (summary.length > config.textToSummaryMaxLength) {
        summary = summary.substring(0,config.textToSummaryMaxLength) + '…'
      }
    }
    summary = summary.trim()
    if (/^Automatically generated (page|group)/.test(summary)) {
      return ''
    }
    return this.summary = summary
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

  _makeBreadcrumbs(pageIndex) {
    let breadcrumbs = []
    let addBreadcrumbs = (stack,breadcrumbPage)=>{
      if (!breadcrumbPage) return
      stack = Array.from(stack)
      if (breadcrumbPage.parentIds.length > 0) {
        breadcrumbPage.parentIds.forEach(p=>addBreadcrumbs(stack.concat([pageIndex[p]]),pageIndex[p]))
      } else if (stack.length > 0) {
        stack.reverse()
        breadcrumbs.push(flatMap(stack, p=>[`${p.aliasOrId}.html`, p.name]).concat('…'))
      }
    }
    addBreadcrumbs([], this)
    return breadcrumbs.sort()
  }

  _renderPage(pageIndex) {
    let missingLinks = new Set()
    let r = template.page({...this, textHtml: renderPageText(this, pageIndex, missingLinks, this.latexStrings = []), breadcrumbs:this._makeBreadcrumbs(pageIndex), pageIndex:pageIndex})
    this.missingLinks = Array.from(missingLinks).sort()
    return r
  }

  async saveRaw() { if (!this.cached) await this._writeJson('raw', `${this.pageId}.json`, this.rawPageJson) }

  _renderMetadataHtml(pageIndex) {
    let jsonWalkReplace =(o,f,k='')=>{
      if (o instanceof Array) {
        return o.map(x=>jsonWalkReplace(x,f,k))
      } else if (o instanceof Object) {
        let r={}
        for (let ok of Object.keys(o)) r[escapeHtml(ok)] = jsonWalkReplace(o[ok],f,ok)
        return r
      } else {
        return f(o,k)
      }
    }
    let pageJsonHtml = jsonWalkReplace(this.pageJson, (scalar, key)=> {
      let page
      if (!isArbitalPageIdField(key) || !(page = pageIndex[scalar])) return escapeHtml(scalar)
      return template.metadataLink(page)
    })
    return template.metadata({...this, pageJsonHtml:pageJsonHtml, util:util})
  }

  async saveHtml(pageIndex) {
    await this._writeFile('page', `${this.aliasOrId}.html`, this._renderPage(pageIndex))
    await this._writeFile('metadata', `${this.aliasOrId}.json.html`, this._renderMetadataHtml(pageIndex))
  }

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
    if (p.title) { pageIndex[p.title] = p; pageIndex[p.title.toLowerCase()] }
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

  let allPages = lib.sortBy(Array.from(new Set(Object.values(pageIndex))), p=>p.name)

  let savedHtml = new Set()
  for (let page of allPages) {
    if (page.status == PageStatus_page && !savedHtml.has(page.pageId)) {
      savedHtml.add(page.pageId)
      await page.saveHtml(pageIndex)
    }
  }

  let namedTypes = lib.makePagesByType(allPages.filter(p=>p.named), pageIndex).map(e=>e[0])
  let unnamedTypes = lib.makePagesByType(allPages.filter(p=>!p.named), pageIndex).map(e=>e[0])

  let writeFile = async (file,content)=>{
    console.log('writing', file)
    await fs.mkdirp(path.dirname(file))
    await fs.writeFile(file, content)
  }
  let copyFile = async (source,destination,content)=>{
    console.log('copying', source, 'to', destination)
    await fs.copyFile(source, destination)
  }

  let indexLocals = {pageIndex:pageIndex, allPages:allPages, namedTypes:namedTypes, unnamedTypes:unnamedTypes}

  await writeFile(`${argv.directory}/index.html`, template.index({title: 'Arbital Scrape Index', ...indexLocals}))
  await writeFile(`${argv.directory}/debug.html`, template.debug({title: 'Debug', fetchFailures: fetchFailures, ...indexLocals}))
  await writeFile(`${argv.directory}/debug-all-mathjax.html`, template.debugAllMathjax({title: 'Debug - All Mathjax', ...indexLocals}))
  await writeFile(`${argv.directory}/by-type-named.html`, template.indexByType({title: 'By Type (Named)', ...indexLocals, allPages:allPages.filter(p=>p.named)}))
  await writeFile(`${argv.directory}/by-type-unnamed.html`, template.indexByType({title: 'By Type (Unnamed)', ...indexLocals, allPages:allPages.filter(p=>!p.named)}))

  for (let file of ['page-style.css', 'index-style.css', 'common.css']) {
    await copyFile(`template/${file}`, `${argv.directory}/${file}`)
  }

  let exploreRoots = allPages.filter(p=>p.status == PageStatus_page && p.childIds.length > 0 && p.parentIds.length == 0)
  let explorePagesByCategory = {}
  exploreRoots.forEach(p=>(explorePagesByCategory[p.aliasOrId] = explorePagesByCategory[p.aliasOrId] || []).push(...p.childIds))
  await writeFile(`${argv.directory}/explore.html`, template.explore({title: 'Explore', pagesByCategory:explorePagesByCategory, ...indexLocals}))

  let makePagesByCategory = f=>{
    let pagesByCategory = {}
    allPages.forEach(p=>f(p).filter(i=>i).forEach(indexKey=>{
      indexKey = pageIndex[indexKey] ? pageIndex[indexKey].aliasOrId : indexKey
      ;(pagesByCategory[indexKey] = pagesByCategory[indexKey] || []).push(p)
    }))
    return lib.sortBy(Object.entries(pagesByCategory), e=>pageIndex[e[0]] ? pageIndex[e[0]].name : e[0])
  }

  await writeFile(`${argv.directory}/by-creator.html`, template.indexByCategory({title: 'By Creator', skipCreator: true, pagesByCategory:makePagesByCategory(p=>p.pageCreatorId==p.pageId?[]:[p.pageCreatorId]), ...indexLocals}))
  await writeFile(`${argv.directory}/by-editor.html`, template.indexByCategory({title: 'By Editor', pagesByCategory:makePagesByCategory(p=>p.editorIds), ...indexLocals}))
  await writeFile(`${argv.directory}/by-tag.html`, template.indexByCategory({title: 'By Tag', pagesByCategory:makePagesByCategory(p=>p.tagIds), ...indexLocals}))
  await writeFile(`${argv.directory}/by-likes.html`, template.indexByCategory({title: 'By Likes', pagesByCategory:makePagesByCategory(p=>p.individualLikes), ...indexLocals}))

  let fetchUrl = async (url,options)=> {
    console.log('fetching', url)
    try { return await request({method: 'GET', url: url, ...options})
    } catch (e) { console.log(colors.red('failed'), url, e.message) }
  }
  let fetchUrlAsCachedFile = async (file, url, options={})=> {
    if (!options.encoding) options.encoding = null
    if (!await fs.pathExists(file)) {
      let content = await fetchUrl(url, options)
      if (!content) throw `No content at ${url}`
      await writeFile(file, content)
    }
    return file
  }

  if (!await fs.pathExists(`${argv.directory}/MathJax-${sanitizeFilename(config.mathjaxVersion)}`)) {
    let mathjaxZipFile = await fetchUrlAsCachedFile(
      `tmp/mathjax-${sanitizeFilename(config.mathjaxVersion)}.zip`,
      `https://github.com/mathjax/MathJax/archive/${config.mathjaxVersion}.zip`)
    console.log('extracting', mathjaxZipFile, 'to', argv.directory)
    new Zip(mathjaxZipFile).extractAllTo(argv.directory, /*overwrite=*/false)
  }

  if (!argv['cache-only']) {
    await fetchUrlAsCachedFile(`${argv.directory}/unused/arbital-bundle.js`, `${argv.url}/static/js/bundle.js`)
    await fetchUrlAsCachedFile(`${argv.directory}/arbital-demo-bundle.js`, `${argv.url}/static/js/lib/demo-bundle.js`)
  }

  if (Object.keys(fetchFailures).length > 0) {
    console.log('')
    console.log('Fetch failures:')
    for (let aliasOrId of Object.keys(fetchFailures)) {
      let error = fetchFailures[aliasOrId]
      pageIndex[aliasOrId].log(colors.red('failed'), error.message)
    }
  }
})()
