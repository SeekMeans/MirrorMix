# 给固定的二级域名配 HTTPS 证书

服务器上为 MirrorMix 装好的 acme.sh 也能管其他域名的证书，例如 `app.seekmeans.cn`。新签的证书会和 `*.mm.seekmeans.cn` 一样自动续期，不用再配一套。

下文都以 `app.seekmeans.cn` 为例，换成你要用的名字即可。

## 先弄清楚一件事

现在的证书是 `*.mm.seekmeans.cn`。泛域名证书只管它下面一层，所以：

| 域名 | 能不能用现在的证书 |
| --- | --- |
| `office.mm.seekmeans.cn` | 能 |
| `app.seekmeans.cn` | 不能，要另签 |
| `seekmeans.cn` | 不能，要另签 |

## 为什么能直接沿用

搭 MirrorMix 服务器时已经做好了这些，见 [README 的“从外网访问”](../README.md#多台电脑共用一台服务器设置里一键开启)：

- **阿里云密钥已存好**：在 `~/.acme.sh/account.conf` 里。签新证书时 acme.sh 会自动用它，不用再 `export Ali_Key`。
- **权限够用**：RAM 子账号的权限是 `AliyunDNSFullAccess`，能改整个 `seekmeans.cn` 的解析记录，不只是 `mm` 这一层。
- **自动续期已在跑**：acme.sh 安装时加了每天检查的定时任务，用 `crontab -l` 能看到。它签过的证书，到期前都会自动续，包括以后新签的。

## 步骤

### 1. 加 DNS 解析

在阿里云 `seekmeans.cn` 的云解析 DNS 里加一条记录：

| 主机记录 | 类型 | 记录值 |
| --- | --- | --- |
| `app` | A | 云服务器的公网 IP |

现在的 `*.mm` 泛解析不包括 `app.seekmeans.cn`，所以这条要单独加。

### 2. 签证书

在服务器上运行：

```bash
acme.sh --issue --dns dns_ali -d 'app.seekmeans.cn'
```

一两分钟后出现 `Cert success`，证书就签好了。

### 3. 把证书装到 nginx 用的位置

```bash
mkdir -p /etc/nginx/ssl/app.seekmeans.cn
```

```bash
acme.sh --install-cert -d 'app.seekmeans.cn' \
  --key-file /etc/nginx/ssl/app.seekmeans.cn/key.pem \
  --fullchain-file /etc/nginx/ssl/app.seekmeans.cn/fullchain.pem \
  --reloadcmd "systemctl reload nginx"
```

acme.sh 会记住这些路径和 `--reloadcmd`。以后自动续期时，它会把新证书写到同样的位置，然后重载 nginx。

### 4. 给 nginx 加一个站点

新建 `/etc/nginx/conf.d/app.conf`。按这个域名后面接的是什么，选下面一种写法。

**A. 转到服务器本机上的某个服务**（例如监听 `127.0.0.1:3000` 的程序）：

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name app.seekmeans.cn;

    ssl_certificate     /etc/nginx/ssl/app.seekmeans.cn/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/app.seekmeans.cn/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # 用到 WebSocket 时需要这三行。
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

**B. 通过 frp 转到你自己的某台电脑**：nginx 和 MirrorMix 一样，都交给本机 8080 上的 frps，frps 按 `Host` 找到对应的电脑。

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name app.seekmeans.cn;

    ssl_certificate     /etc/nginx/ssl/app.seekmeans.cn/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/app.seekmeans.cn/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:8080;
        # frps 靠 Host 分给对应的电脑，要原样转发。
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

那台电脑的 frpc 里加一个代理，用 `customDomains` 写完整域名，不要用 `subdomain`，因为 `subdomain` 只能在 `mm.seekmeans.cn` 下面起名：

```toml
[[proxies]]
name = "app"
type = "http"
localIP = "127.0.0.1"
localPort = 3000
customDomains = ["app.seekmeans.cn"]
```

`serverAddr`、`serverPort`、`auth.token` 和 MirrorMix 用的是同一个 frps，照着填就行。`name` 不能和别的代理重名；MirrorMix 自己的代理叫 `mirrormix-电脑名`，避开即可。

改完 nginx，检查配置再重载：

```bash
nginx -t
```

```bash
systemctl reload nginx
```

### 5. 确认

| 做什么 | 应该看到 |
| --- | --- |
| `acme.sh --list` | 列表里有 `app.seekmeans.cn`，说明它会自动续期 |
| `curl -I https://app.seekmeans.cn` | 有响应，并且没有证书错误 |
| 浏览器打开 `https://app.seekmeans.cn` | 地址栏显示锁，证书颁发给 `app.seekmeans.cn` |

## 以后要加很多个二级域名

如果之后还会有 `blog`、`api` 之类的，可以签一张 `*.seekmeans.cn` 的泛域名证书，带上 `seekmeans.cn` 本身。这样所有二级域名共用一张证书，DNS 也可以加一条 `*` 的泛解析，以后加新域名只要改 nginx：

```bash
acme.sh --issue --dns dns_ali -d '*.seekmeans.cn' -d 'seekmeans.cn'
```

```bash
mkdir -p /etc/nginx/ssl/seekmeans.cn
```

```bash
acme.sh --install-cert -d '*.seekmeans.cn' \
  --key-file /etc/nginx/ssl/seekmeans.cn/key.pem \
  --fullchain-file /etc/nginx/ssl/seekmeans.cn/fullchain.pem \
  --reloadcmd "systemctl reload nginx"
```

这张证书和 `*.mm.seekmeans.cn` 那张互不影响，两张都会自动续期，MirrorMix 的配置不用动。

注意：加了 `*` 泛解析后，所有没单独配置的子域名都会解析到这台服务器。`deploy/nginx.conf` 末尾那个 `default_server` 会直接断开这些请求，不会把它们误转给 MirrorMix。

## 日常维护

| 做什么 | 命令 |
| --- | --- |
| 看所有证书和到期时间 | `acme.sh --list` |
| 立刻续一张（测试用） | `acme.sh --renew -d 'app.seekmeans.cn' --force` |
| 不再需要某个域名 | `acme.sh --remove -d 'app.seekmeans.cn'`，再删掉 nginx 里对应的配置 |
| 看续期日志 | `cat ~/.acme.sh/acme.sh.log` |

## 出问题时

| 现象 | 原因和处理 |
| --- | --- |
| 签证书时报 `Error add txt for domain` | 阿里云密钥失效或权限不够。确认 RAM 子账号还在，并且有 `AliyunDNSFullAccess` |
| 签好了，但浏览器提示证书不对 | nginx 的 `server_name` 或证书路径写错了，或者没有重载。先 `nginx -t`，再 `systemctl reload nginx` |
| 打开是 MirrorMix 的 frps“页面不存在”提示 | 走了 B 方案，但 frpc 的 `customDomains` 没写对，或者那台电脑的 frpc 没连上 |
| 打不开，连接被断开 | DNS 还没生效，或者请求落到了 `default_server`。用 `nslookup app.seekmeans.cn` 确认解析到了服务器 |
| 国内服务器 443 打不开 | `seekmeans.cn` 的 ICP 备案要接入阿里云 |
