module.exports = {
  maxBy: (os,f)=> {
    os = os.map(o=>[o,f(o)])
    let max = Math.max(...os.map(o=>o[1]))
    for (let o of os) { if (max == o[1]) return o[0] }
  },
  sortBy: (array,f)=>array.sort((a,b)=>{ a = f(a); b = f(b); return a<b?-1:a==b?0:1 })
}
