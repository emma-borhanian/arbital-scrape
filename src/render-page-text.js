let showdown = require('showdown')
let escapeHtml = require('escape-html')

let renderPageLinks = require('./render-page-links.js')

let showdownConverter = new showdown.Converter()
showdownConverter.setOption('simplifiedAutoLink', true)

module.exports = (page, pageIndex, missingLinks=new Set(), latexStrings=[])=>{
  let textMarkdown = page.text

  let getCanonicalPageKey = (key)=>{
    let canonPage = pageIndex[key.toLowerCase()]
    if (!canonPage) missingLinks.add(key)
    return canonPage ? canonPage.aliasOrId : key
  }

  textMarkdown = textMarkdown
    .replace(/https?:\/\/arbital.com\/p\/([^/\s.!?;:)\]]*)\/?/g, (_,m)=>`${getCanonicalPageKey(m)}.html`)

  // These are bugs on arbital.com already
  if (page.alias == 'modal_combat') textMarkdown = textMarkdown.replace('Sadly no. Consider the bot TrollBot$', 'Sadly no. Consider the bot $TrollBot$')
  if (page.alias == 'supply_and_demand') textMarkdown = textMarkdown.replace(/(?<!\\)\$(\d+)\/bushel/g, (_,m)=>`\\$${m}/bushel`)
  if (page.alias == 'kripke_model') textMarkdown = textMarkdown.replace(/w ?\\in ?W/g, 'w \\in W')

  // Escape MathJax for markdown
  let processMathjax = unmatchedText=>{
    let result = ''
    let appendText = ''
    while (unmatchedText) {
      let matchDouble = unmatchedText.match(/\$\$(?<latex>(?:[^$]|\$[^$])+?)\$\$(?<extraChar>.|\n|$)/)
      let matchSingle = unmatchedText.match(/\$(?<latex>(?:[^$\\]|\\{2}|\\[^$\\]|\\\$)+?)\$(?<extraChar>.|\n|$)/)
      if (!matchDouble && !matchSingle) break
      let matchedDouble = matchDouble && matchDouble.index <= matchSingle.index
      let match = matchedDouble ? matchDouble : matchSingle
      let [fullMatch] = match
      let {groups:{latex,extraChar},index} = match

      let prefixString = result + appendText + unmatchedText.substring(0,index)
      let skip =
           // Escaped $
           /(^|[^\\])(\\{2})*\\$/.test(prefixString)

           // Supposed to be single $ but prefixed with unescaped $
        || (!matchedDouble && /(^|[^\\])(\\{2})*\$$/.test(prefixString))

           // Not double $$
        || (!matchedDouble && latex.includes('\n'))

      if (skip) {
        appendText += unmatchedText.substring(0, index + 1)
        unmatchedText = unmatchedText.substring(index + 1)
        continue
      }

      latex = '$~$' + latex.replace(/\\/g, '\\\\').replace(/\*|=|#|_|\[|\]/g, (m)=>`\\${m}`) + '$~$' // Escape for markdown
      if (matchedDouble) latex = '$' + latex + '$'
      latexStrings.push(showdownConverter.makeHtml(latex))
      result += renderPageLinks(appendText + unmatchedText.substring(0, index), pageIndex, missingLinks) + latex
      appendText = extraChar
      unmatchedText = unmatchedText.substring(index + fullMatch.length)
    }
    return result + renderPageLinks(appendText + unmatchedText, pageIndex, missingLinks)
  }

  let processComments = unmatchedText=>{
    let result = ''
    while (unmatchedText) {
      let match = unmatchedText.match(/%%%?comment:(.|\n)*?%%%?/)
      if (!match) break
      let [fullMatch] = match
      let {index} = match
      result += processMathjax(unmatchedText.substring(0, index))
      result += '<pre>' + escapeHtml(fullMatch) + '</pre>'
      unmatchedText = unmatchedText.substring(index + fullMatch.length)
    }
    return result + processMathjax(unmatchedText)
  }
  textMarkdown = processComments(textMarkdown)

  return showdownConverter.makeHtml(textMarkdown)
}
