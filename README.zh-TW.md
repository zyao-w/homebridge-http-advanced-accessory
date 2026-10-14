<p align="center"><img src="https://raw.githubusercontent.com/zyao-w/homebridge-http-advanced-accessory/master/branding/icon.png" width="100" height="100" alt="HTTP Advanced Accessory icon"></p>

<h1 align="center">homebridge http advanced accessory</h1>

<p align="center"><a href="README.md">English</a> | 繁體中文</p>

<p align="center">
  <a href="https://github.com/zyao-w/homebridge-http-advanced-accessory/actions/workflows/ci.yml"><img src="https://github.com/zyao-w/homebridge-http-advanced-accessory/actions/workflows/ci.yml/badge.svg" alt="Tests" /></a>
  <a href="https://www.npmjs.com/package/homebridge-http-advanced-accessory-zyao"><img src="https://img.shields.io/npm/v/homebridge-http-advanced-accessory-zyao" alt="npm version" /></a>
  <a href="https://github.com/zyao-w/homebridge-http-advanced-accessory/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/homebridge-http-advanced-accessory-zyao" alt="License" /></a>
  <a href="https://www.npmjs.com/package/homebridge-http-advanced-accessory-zyao"><img src="https://img.shields.io/npm/d18m/homebridge-http-advanced-accessory-zyao.svg" alt="npm downloads" /></a>
  <a href="https://github.com/zyao-w/homebridge-http-advanced-accessory/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/Node.js-22%20%7C%2024-339933?logo=nodedotjs&logoColor=white" alt="Tested on Node.js 22 and 24" /></a>
</p>

這是一個 Homebridge 外掛，可以把幾乎任何提供 HTTP API 的裝置變成 HomeKit 配件。每個裝置都在設定檔中描述：它是哪一種 HomeKit 服務、要呼叫哪些 URL 來「讀取」與「變更」每個特性（characteristic），以及如何把回應轉換成 HomeKit 需要的值。

本專案是 [homebridge-http-advanced-accessory](https://github.com/staromeste/homebridge-http-advanced-accessory) 的修改分支，獨立維護。新增了 Bearer Token 驗證、請求快取與去重、逾時與重試，以及（自 2.0.0 起）Dynamic Platform 與 Homebridge UI 表單。

> **從 1.x 升級？** 2.0.0 是不相容的變更：`HttpAdvancedAccessory` 配件已改為 `HttpAdvancedPlatform` 平台。請參閱 [MIGRATION.md](MIGRATION.md)，`scripts/migrate-config.js` 可以自動轉換你的設定。

> 本文件僅為簡要說明，完整且最新的內容請以英文版 [README.md](README.md) 為準。

## 安裝

1. 安裝 Homebridge（需要 Homebridge 1.8.5 以上與 Node.js 22 以上）：`npm install -g homebridge`
2. 安裝本外掛：`npm install -g homebridge-http-advanced-accessory-zyao`
3. 在 Homebridge UI（外掛頁面 > 設定）中設定，或把下方的平台區塊加入 `config.json` 最上層的 `platforms` 清單。本專案的 `sample-config.json` 是完整範例。

## 功能

- 可設定讀取與寫入每個特性的 HTTP 端點，支援 GET、POST（以及 PUT、PATCH、DELETE），參數可放在 URL 或請求本文
- 支援 Bearer Token 與 HTTP Basic 驗證；Token 可來自環境變數或檔案
- 自訂請求標頭（API 金鑰、`Content-Type` 等），可套用於全部裝置、單一裝置或單一動作
- 以 mapper 串接（正規表示式、XPath、JSONPath、靜態對照表、數字、縮放、expression、script）把回應轉成 HomeKit 的值；回應無法判斷時可使用備援動作
- URL 與請求本文的範本，可使用要設定的值與其他特性目前的狀態
- 定時輪詢，即使裝置被其他方式改變，HomeKit 也能收到通知
- 選用的 Status Fault，讀取失敗時 Home App 會顯示配件故障
- 讀取相同 URL 的特性共用一次請求、短時間回應快取、請求逾時、讀取重試，以及同時請求數上限
- 修改設定時，配件在 HomeKit 中的身分保持不變
- Homebridge UI 中的管理頁與設定精靈，與標準表單並存

## Homebridge UI：管理頁與設定精靈

外掛在 Homebridge UI 的設定會先開啟專屬的頁面，**標準表單仍然保留**在下方，所有設定都可以在那裡編輯，兩邊的修改會互相同步。可以用「隱藏標準表單」收起它。頁面支援英文與繁體中文，並跟隨 Homebridge UI 的語言。

在設定視窗按下「儲存」之前，不會寫入 `config.json`，與標準表單相同。儲存後需重新啟動 Homebridge，新增或修改的裝置才會生效。

### 設定精靈

尚未設定任何裝置時，設定頁會開啟精靈；隨時可以略過（「略過，使用標準表單」），之後也可以從「新增裝置（精靈）」進入。第一版支援：

- 只讀取的感測器：溫度、濕度、動作、接觸、漏水、煙霧、人員
- 開關與燈：可以開關，燈還能讀取並設定亮度

步驟依序是：裝置類型、連線（名稱、URL、方法、驗證）、讀取數值、解讀數值、控制（開關與燈）、選項（輪詢、Status Fault、`id`）與摘要。在「讀取數值」時，外掛會送出請求、顯示裝置的回應，並列出找到的值（JSON 以 JSONPath、XML 以 XPath 表示）；點選其中一個就會填入路徑，並顯示 HomeKit 會得到的值。其他種類的裝置請選「其他」，會建立空白裝置並開啟編輯。

精靈寫入的設定與表單相同，並通過啟動時相同的驗證，所以摘要會告訴你外掛是否會拒絕這個裝置。

### 管理頁

管理頁列出所有裝置與狀態（日誌在啟動時會顯示的錯誤與警告），並可以：

- 用精靈或空白裝置新增、複製、刪除（需確認）與調整裝置順序
- 以獨立表單編輯單一裝置的全部設定（特性、mapper、額外服務、標頭、驗證），或平台的「預設值」
- 「測試讀取」`get` 動作，顯示 HTTP 狀態、回應與每個 mapper 的結果（包含備援動作）；「預覽設定」則顯示某個值會產生的 URL 與本文，但不會送出任何請求
- 把裝置匯出成 JSON 以便貼到 issue；密碼、token 與標頭值會被隱藏，`env:` 與 `file:` 參照則保留
- 匯入 1.x `config.json` 的配件（與 `scripts/migrate-config.js` 相同的轉換），並列出需要確認的項目
- 顯示 HomeKit 為本外掛快取的配件，以及其中已不在設定中的配件

只有設定了 `id` 的裝置，改名後才不會變成新配件；編輯時頁面會提醒這一點。

### 測試請求與安全性

「測試讀取」與精靈會從 Homebridge 主機送出請求，使用裝置的驗證與標頭，做法與外掛本身完全相同。以 `env:` 或 `file:` 設定的 `bearerToken` 或標頭值只在伺服器端讀取，不會送到瀏覽器。回應會依裝置傳回的內容顯示給你（超過 4000 個字元會截斷），所以可能包含裝置傳回的任何資訊。

當 Homebridge UI 設為**不需登入**（`config` 平台的 `"auth": "none"`）時，網路上任何人都能開啟它的設定，因此外掛完全不送出測試請求，頁面也會說明原因，其他功能照常運作。只會測試 `http` 與 `https` 的 URL。

## 設定

平台有一個選用的 `defaults`（所有裝置繼承的預設值）與一個 `devices`（裝置清單）：

```json
{
  "platforms": [
    {
      "platform": "HttpAdvancedPlatform",
      "name": "HTTP Advanced",
      "defaults": { "forceRefreshDelay": 5, "timeout": 5000, "bearerToken": "env:MY_API_TOKEN" },
      "devices": [
        {
          "name": "Terrace Sensor",
          "service": "ContactSensor",
          "characteristics": [
            {
              "characteristic": "ContactSensorState",
              "get": {
                "url": "http://remoteserver/xml/zones/zonesStatus48IP.xml",
                "mappers": [
                  { "type": "xpath", "xpath": "//status[1]/text()" },
                  {
                    "type": "static",
                    "mapping": [
                      { "from": "ALARM", "to": "1" },
                      { "from": "NORMAL", "to": "0" }
                    ]
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  ]
}
```

Homebridge 啟動時會驗證設定；有錯誤的裝置會在日誌中指出設定名稱並被略過，其他裝置仍正常運作。

### 常用裝置設定

| 設定                                    | 說明                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `name`                                  | 配件在 HomeKit 中的名稱。必填。                                                            |
| `id`                                    | 選用的固定識別碼。未設定時以 `name` 識別配件，改名會被視為新配件；設定 `id` 後可自由改名。 |
| `service`                               | HomeKit 服務，例如 `Switch`、`Lightbulb`、`TemperatureSensor`。必填。                      |
| `optionCharacteristic`                  | 要啟用的選用特性清單，例如 `["Brightness"]`。                                              |
| `manufacturer`、`model`、`serialNumber` | 顯示於 HomeKit 的配件資訊。                                                                |
| `characteristics`                       | 要讀取與寫入的特性清單。                                                                   |
| `additionalServices`                    | 同一配件上的其他服務。                                                                     |
| `forceRefreshDelay`                     | 輪詢間隔（秒），預設 0，表示不輪詢。                                                       |
| `setterDelay`                           | 送出設定請求前的等待毫秒數，期間若有新請求只會送出最後一個。預設 0。                       |
| `username`、`password`                  | HTTP Basic 帳號密碼。                                                                      |
| `bearerToken`                           | Bearer Token，可寫成 `env:變數名稱` 或 `file:/路徑/檔案`。                                 |
| `headers`                               | 額外的請求標頭。                                                                           |
| `statusFault`                           | 設為 `true` 時，讀取失敗會讓 Status Fault 顯示故障。預設 `false`。                         |
| `timeout`                               | 請求逾時毫秒數，預設 10000；0 表示不逾時。                                                 |
| `retries`                               | 讀取請求遇到網路錯誤或逾時時的額外重試次數，預設 0。                                       |
| `cacheTTL`                              | 成功的讀取回應重複使用的秒數。                                                             |
| `maxConcurrent`                         | 單一裝置同時進行的 HTTP 請求上限，預設 0（不限制）。                                       |
| `allowUnsafeEval`                       | 允許 `script` mapper 與範本中的 JavaScript，預設 `false`。                                 |
| `debug`                                 | 記錄每個請求與完整的對應過程。                                                             |

### 特性（characteristics）

`characteristics` 的每個項目對應服務中的一個 HomeKit 特性：

```json
{
  "characteristic": "TargetTemperature",
  "get": { "url": "http://remoteserver/temperature" },
  "set": { "url": "http://remoteserver/setTemperature?stemp={value}" },
  "props": { "minValue": 16, "maxValue": 30, "minStep": 0.5 }
}
```

- `characteristic`：HomeKit 特性名稱（比對時忽略空白）。
- `get`：讀取數值的動作；沒有時，特性不會輪詢，只回傳最後已知的值。
- `set`：寫入數值的動作；沒有時，HomeKit 設定的值會被接受，但不會送出任何請求。
- `props`：覆寫特性屬性，例如 `minValue`、`maxValue`、`minStep`、`validValues`。

### 動作（action）

`get` 與 `set` 使用相同的設定：`url`（必填）、`httpMethod`、`body`、`mappers`、`resultOnError`、`bearerToken`、`headers`、`inconclusive`。

在 `set` 動作的 URL 與 `body` 中，`{value}` 會被替換成經過 mapper 處理後的值，`${...}` 可寫運算式，並可使用 `value`（HomeKit 要設定的值）與 `state`（各特性目前的狀態，例如 `state.TargetTemperature`）。

### Mapper

Mapper 串接會把回應逐步轉換成 HomeKit 需要的單一數值，前一個 mapper 的輸出是下一個的輸入。可用類型：`static`、`regex`、`xpath`、`jpath`、`number`、`scale`、`expression`、`script`。

## 驗證

1. **Bearer Token**：設定 `bearerToken`，外掛會送出 `Authorization: Bearer <token>`。
2. **HTTP Basic**：設定 `username` 與 `password`（未設定 `bearerToken` 時使用）。

兩者都設定時以 Bearer Token 為準。不支援 HTTP Digest 驗證。

## 疑難排解

- 在裝置中設定 `"debug": true`，即可在日誌中看到每個請求與對應過程。
- 讀取失敗時，Home App 會顯示「無回應」，原因會寫入 Homebridge 日誌。
- 更多支援的服務、設定範例（Bticino、Daikin、Yamaha Musiccast 等）與完整選項，請見 [README.md](README.md)。

## 授權

請見 [LICENSE](LICENSE)。
