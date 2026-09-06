const {runBackup} = require('./lib/backup');
runBackup().then(r=>{console.log(JSON.stringify(r,null,2)); process.exit(r.ok?0:1)}).catch(e=>{console.error(e); process.exit(1)});
