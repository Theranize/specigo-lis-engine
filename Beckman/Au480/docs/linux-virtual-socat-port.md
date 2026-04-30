Linux me **com0com** use nahi hota.
👉 **com0com = Windows only virtual COM port driver**.

Linux me same kaam ke liye **pseudo serial ports (virtual RS232 ports)** banaye jaate hain.

Sabse best tool:

# ✅ Linux Virtual COM Port (com0com alternative)

## 1. Install `socat`

```bash
sudo apt update
sudo apt install socat
```

---

## 2. Create Virtual Serial Pair

```bash
## Forground
socat -d -d pty,raw,echo=0,link=/dev/ttyV0 pty,raw,echo=0,link=/dev/ttyV1

## Background
nohup socat -d -d \
pty,raw,echo=0,link=/dev/ttyV0 \
pty,raw,echo=0,link=/dev/ttyV1 \
> socat.log 2>&1 &
```

Output kuch aisa dikhega:

```
PTY is /dev/pts/3
PTY is /dev/pts/4
```

Aur tumhare paas ban jayega:

```
/dev/ttyV0
/dev/ttyV1
```

👉 Ye dono **virtual RS232 cable** ki tarah connected hote hain.

```
Program A  ---> /dev/ttyV0
Program B  ---> /dev/ttyV1
```

Jo ek me likhoge → dusre me milega.

---

## 3. Test Virtual Port

### Terminal 1

```bash
cat /dev/ttyV1
```

### Terminal 2

```bash
echo "HELLO" > /dev/ttyV0
```

Output:

```
HELLO
```

✅ Working virtual COM pair.

---

## 4. Node.js SerialPort Example

```js
const { SerialPort } = require('serialport');

const port = new SerialPort({
  path: '/dev/ttyV0',
  baudRate: 9600,
});

port.write('TEST DATA\n');
```

Dusri app `/dev/ttyV1` open karegi.

---

## 5. Permanent Virtual Ports (Auto Create)

Systemd service bana sakte ho:

```bash
sudo nano /etc/systemd/system/virtual-com.service
```

```
[Unit]
Description=Virtual COM Ports

[Service]
ExecStart=/usr/bin/socat pty,raw,echo=0,link=/dev/ttyV0 pty,raw,echo=0,link=/dev/ttyV1
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl enable virtual-com
sudo systemctl start virtual-com
```

---

# ✅ Summary

| Windows   | Linux                 |
| --------- | --------------------- |
| com0com   | socat                 |
| COM5/COM6 | /dev/ttyV0 /dev/ttyV1 |
| Driver    | Pseudo TTY            |

---

Agar tum **AU480 analyzer simulation**, **LIS engine testing**, ya **RS232 debugging** kar rahe ho — ye industry standard method hai Linux me.

Agar chaho to next me main bata sakta hoon:

✅ AU480 simulator banana (Linux)
✅ RS232 packet sniffer banana
✅ LIS ↔ Analyzer full testing setup
✅ Windows ↔ Linux serial bridge

Bolo 👍.
