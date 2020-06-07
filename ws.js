const { EventEmitter } = require('events');
const { createServer } = require('http');
const crypto = require('crypto');

const magicStr = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function hashWebSocketKey(key) {
  return crypto.createHash('sha1').update(key + magicStr).digest('base64');
}

const OPCODES_MAP = {
  CONTINUE: 0,
  TEXT: 1,
  BINARY: 2,
  CLOSE: 8,
  PING: 9,
  PONG: 10,
};


class MyWebsocket extends EventEmitter {
  constructor(options) {
    super(options);
    this.socket = null;
    this.closed = false;
    this.options = options;
    this.server = createServer();
    options.port ? this.server.listen(options.port) : this.server.listen(8080);

    this.server.on('upgrade',(req,socket) => {
      const key = req.headers['sec-websocket-key'];
      console.log('key:',key);
      const responseKey = hashWebSocketKey(key)
      console.log('responseKey:',responseKey);
      this.socket = socket;
      const resHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Accept: ' + responseKey,
              ].concat('', '').join('\r\n');
      socket.write(resHeaders); // 返回响应头部

      this.socket.on('data',(buf) => {
        const byte1 = buf.readUInt8(0); // 读取buffer数据的前8 bit并转换为十进制整数
        // 获取第一个字节的最高位，看是0还是1
        const str1 = byte1.toString(2); // 将第一个字节转换为二进制的字符串形式
        const FIN = str1[0];
        console.log(this.decodeMessage(buf));
      });

      socket.on('close', (error) => {
        // 监听客户端连接断开事件
        if (!this.closed) {
          this.emit('close', 1006, 'timeout');
          this.closed = true;
        }
      });
    });

    this.send = (data) => {
      let opcode;
      let buffer;
      if (Buffer.isBuffer(data)) {
        // 如果是二进制数据
        opcode = OPCODES_MAP.BINARY; // 操作码设置为二进制类型
        buffer = data;
      } else if (typeof data === 'string') {
        // 如果是字符串
        opcode = OPCODES_MAP.TEXT; // 操作码设置为文本类型
        buffer = Buffer.from(data, 'utf8'); // 将字符串转换为Buffer数据
      } else {
        throw new Error('cannot send object.Must be string of Buffer');
      }

      this.socket.write(this.encodeMessage(opcode, buffer));
    }

    this.encodeMessage = (opcode, payload) => {
      let buf;
      // 0x80 二进制为 10000000 | opcode 进行或运算就相当于是将首位置为1
      let b1 = 0x80 | opcode; // 如果没有数据了将FIN置为1
      let b2; // 存放数据长度
      let length = payload.length;
      if (length < 126) {
        buf = Buffer.alloc(payload.length + 2 + 0); // 服务器返回的数据不需要加密，直接加2个字节即可
        b2 = length; // MASK为0，直接赋值为length值即可
        buf.writeUInt8(b1, 0); //从第0个字节开始写入8位，即将b1写入到第一个字节中
        buf.writeUInt8(b2, 1); //读8―15bit，将字节长度写入到第二个字节中
        payload.copy(buf, 2); //复制数据,从2(第三)字节开始,将数据插入到第二个字节后面
      }
      return buf;
    }

    this.decodeMessage = (buf) => {
        let idx = 2; // 首先分析前两个字节
        // 处理第一个字节
        const byte1 = buf.readUInt8(0); // 读取buffer数据的前8 bit并转换为十进制整数
        // 获取第一个字节的最高位，看是0还是1
        const str1 = byte1.toString(2); // 将第一个字节转换为二进制的字符串形式
        const FIN = str1[0];
        // 获取第一个字节的后四位，让第一个字节与00001111进行与运算，即可拿到后四位
        let opcode = byte1 & 0x0f; //截取第一个字节的后4位，即opcode码, 等价于 (byte1 & 15)
        // 处理第二个字节
        const byte2 = buf.readUInt8(1); // 从第一个字节开始读取8位，即读取数据帧第二个字节数据
        const str2 = byte2.toString(2); // 将第二个字节转换为二进制的字符串形式
        const MASK = str2[0]; // 获取第二个字节的第一位，判断是否有掩码，客户端必须要有
        let length = parseInt(str2.substring(1), 2); // 获取第二个字节除第一位掩码之后的字符串并转换为整数
        if (length === 126) {
          // 说明125<数据长度<65535（16个位能描述的最大值，也就是16个1的时候)
          length = buf.readUInt16BE(2); // 就用第三个字节及第四个字节表示数据的长度
          idx += 2; // 偏移两个字节
        } else if (length === 127) {
          // 说明数据长度已经大于65535，16个位也已经不足以描述数据长度了，就用第三到第十个字节这八个字节来描述数据长度
          const highBits = buf.readUInt32BE(2); // 从第二个字节开始读取32位，即4个字节，表示后8个字节（64位）用于表示数据长度，其中高4字节是0
          if (highBits != 0) {
            // 前四个字节必须为0，否则数据异常，需要关闭连接
            this.close(1009, ''); //1009 关闭代码，说明数据太大； 协议里是支持 63 位长度，不过这里我们自己实现的话，只支持 32 位长度，防止数据过大；
          }
          length = buf.readUInt32BE(6); // 获取八个字节中的后四个字节用于表示数据长度，即从第6到第10个字节，为真实存放的数据长度
          idx += 8;
        }
        let realData = null; // 保存真实数据对应字符串形式
        if (MASK) {
          // 如果存在MASK掩码，表示是客户端发送过来的数据，是加密过的数据，需要进行数据解码
          const maskDataBuffer = buf.slice(idx, idx + 4); //获取掩码数据, 其中前四个字节为掩码数据
          idx += 4; //指针前移到真实数据段
          const realDataBuffer = buf.slice(idx, idx + length); // 获取真实数据对应的Buffer

          const payload = Buffer.alloc(realDataBuffer.length);
          for (let i = 0; i < realDataBuffer.length; i++) {
            // 遍历真实数据
            payload[i] = maskDataBuffer[i % 4] ^ realDataBuffer[i]; // 掩码有4个字节依次与真实数据进行异或运算即可
          }
          realData = payload;
          console.log(`realData is ${realData}`);
        }
        let realDataBuffer = Buffer.from(realData); // 将真实数据转换为Buffer
        buf = buf.slice(idx + length); // 清除已处理的buffer数据
        
        if (FIN) {
          // 如果第一个字节的第一位为1,表示是消息的最后一个分片，即全部消息结束了(发送的数据比较少，一次发送完成)
          // 处理操作码
          switch (opcode) {
            case OPCODES_MAP.TEXT:
              this.emit('data', realDataBuffer.toString('utf8')); // 服务端WebSocket监听data事件即可拿到数据
              break;
            case OPCODES_MAP.BINARY: //二进制文件直接交付
              this.emit('data', realDataBuffer);
              break;
            default:
              this.close(8, 'unhandle opcode:' + opcode);
          }
        }
    };

    this.close = (code, msg) => {
      if(!code) {
        this.socket.destroy()
      } else {
        this.socket.write(this.encodeMessage(code, Buffer.from(msg)));
      }
    }
  
  };

}
module.exports = MyWebsocket;
