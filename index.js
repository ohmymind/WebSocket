const MyWebSocket = require('./ws');
const ws = new MyWebSocket({ port: 9999 });
ws.on('data', (data) => {
  console.log('receive data:' + data);
  ws.send('这是一条来自服务端的数据');
});

ws.on('close', (code, reason) => {
  console.log('close:', code, reason);
});