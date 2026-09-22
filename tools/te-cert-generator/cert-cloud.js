/**
 * 证书 PDF 转换 —— 云端 API 适配层（浏览器直连，无后端）
 *
 * 为什么走云端而不是浏览器自绘：
 *   模板 100% 使用「思源黑体 CN」三个字重。要在浏览器里画出一模一样的 PDF，
 *   必须把整套中文字体嵌进去（23.9MB base64 载荷），而且 pdf-lib 对这套字体的
 *   子集化是坏的（subset:true 会静默产出没有文字的空文件）。折腾过一轮，
 *   字重、间距、体积接连出问题，最后被判定不可用。
 *   云端引擎跑的是真正的 Word / LibreOffice，排版天然一致，浏览器只管上传下载。
 *
 * 为什么不需要后端：
 *   已实测各服务商的 CORS 预检（2026-09 验证）：
 *     ConvertAPI   OPTIONS 200  access-control-allow-origin: 回显请求 Origin
 *     CloudConvert OPTIONS 204  access-control-allow-origin: *
 *     Adobe        OPTIONS 204  access-control-allow-origin: *（含 IMS 令牌端点）
 *   所以静态页面可以直接调，API Key 存在浏览器 localStorage，不经过任何中间服务器。
 *   注意 WPS 金山文档开放平台**没有** CORS 头，浏览器直连不可用，故未纳入。
 *
 * 隐私：选了云转换就意味着证书内容会离开本机。工具里必须对用户讲清楚这一点，
 *       不能默认静默上传。默认值设为「不转换」，由用户显式选择服务商。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.CertCloud = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DOCX_MIME =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  /**
   * 只含一个分页符的空段落，用于合批时把每份证书推到新的一页。
   * <w:br w:type="page"/> 是显式分页指令，不依赖任何浮动对象的高度。
   */
  const PAGE_BREAK_PARAGRAPH = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

  /** 单次批量的份数上限：免费额度有限，超过这个数应先分批，避免中途额度耗尽。 */
  const MAX_BATCH = 200;

  /** 单份转换的等待上限（毫秒）。Adobe 要轮询，给它宽一点。 */
  const DEFAULT_TIMEOUT_MS = 120000;

  /* ------------------------------------------------------------ 工具函数 */

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 页面是不是 file:// 打开的。file:// 的 origin 是不透明的 null。 */
  const IS_FILE_PROTOCOL =
    typeof location !== "undefined" && location.protocol === "file:";

  /**
   * 浏览器对跨域失败的报错几乎不可诊断，这里翻译成人话。
   *
   * 为什么要专门认 CORS：
   *   多数服务商只在**成功响应**里回 Access-Control-Allow-Origin，出错时（4xx/5xx）
   *   不带。浏览器看到没有 CORS 头的错误响应，就报成
   *     "No 'Access-Control-Allow-Origin' header is present on the requested resource"
   *   把真正的 400 / 401 原因整个盖掉。用户看到的"没有 CORS 头"往往是
   *   「密钥错了」或「用 file:// 打开了页面」，而不是服务端没配 CORS。
   *
   *   实测（2026-09）Adobe IMS /ims/token/v3：
   *     预检 OPTIONS            → 200，ACAO 回显请求 Origin
   *     成功 POST               → 200，ACAO 回显请求 Origin
   *     失败 POST（400）        → ACAO **缺失**，body 是 {"error":"invalid_client",...}
   *   所以只要 Adobe 报这句 CORS，就说明它返回了 400 —— 是凭据问题。
   */
  function explainNetworkError(error, url) {
    const raw = error && error.message ? error.message : String(error);
    const looksLikeCors = /access-control-allow-origin|cors|blocked by cors policy/i.test(raw);
    // Chrome/Firefox 在网络层失败时会把真实状态码塞在 message 里（net::ERR_FAILED 400）
    const statusMatch = raw.match(/\b(4\d{2}|5\d{2})\b/);
    const httpStatus = statusMatch ? statusMatch[1] : "";

    if (looksLikeCors) {
      const origin = typeof location !== "undefined" ? location.origin : "(未知)";
      const isAdobe = /adobelogin\.com|adobe\.io/.test(url || "");
      const lines = ["跨域请求被拦下。原始报错：" + raw, "当前页面 origin：" + origin];

      if (httpStatus) {
        lines.push(
          "★ 关键：报错里带着真实状态码 " +
            httpStatus +
            "，说明请求**已经到达服务端并被受理**，只是它的错误响应没带 CORS 头，" +
            "浏览器于是把内容挡在外面、包装成「CORS 失败」。这是**次生现象**，" +
            "不是网络或跨域策略问题。真正的原因写在服务端的响应体里，" +
            "需要在 Network 面板的 Response 页签才能看到。",
        );
      }

      if (isAdobe) {
        lines.push(
          "⚠ Adobe 的这个报错有两种可能，请先看状态码：" +
            "若是 400/401 → 凭据问题；若是 (blocked) 且没有状态码 → 可能是端点上仍有 CORS 限制。" +
            "本工具现在用的是文档指定的 https://pdf-services.adobe.io/token（不是 IMS 端点），" +
            "实测该端点在出错时也带 Access-Control-Allow-Origin。请确认：" +
            "① Client ID / Client Secret 来自「PDF Services API」凭据流程下载的 pdfservices-api-credentials.json；" +
            "② 复制时没有多余空格或换行；③ 该凭据未被删除或重置。",
        );
      } else {
        lines.push(
          "注意：这类报错经常是**误导性的** —— 多数服务商只在成功响应里带 CORS 头，" +
            "出错时（如 400/401）不带，于是浏览器把「密钥错误」也报成「没有 CORS 头」。",
        );
      }

      if (IS_FILE_PROTOCOL) {
        lines.push(
          "另外你现在是 file:// 打开（origin 为 null），跨域请求在这种页面上基本会被拦。" +
            "请改用本地服务器：在项目根目录执行 python -m http.server 8000，" +
            "再打开 http://127.0.0.1:8000/tools/te-cert-generator/index.html。",
        );
      }
      return new Error(lines.join("\n"));
    }

    return new Error(
      "网络请求失败：" + raw +
        " —— 常见原因是网络不通、被扩展拦截，或该服务的 CORS 策略不允许本页发起请求。" +
        "可在浏览器 Network 面板查看该请求的真实状态。",
    );
  }

  /** 带超时的 fetch。外部 AbortSignal 与超时谁先触发都算中止。 */
  async function fetchWithTimeout(url, init, timeoutMs, outerSignal) {
    const controller = new AbortController();
    const limit = timeoutMs || DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), limit);
    const onAbort = () => controller.abort();
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
    } catch (error) {
      if (error && error.name === "AbortError") {
        if (outerSignal && outerSignal.aborted) throw error;
        throw new Error("请求超时（超过 " + Math.round(limit / 1000) + " 秒）。");
      }
      throw explainNetworkError(error, url);
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * 把失败原因说得足够清楚，不要只报一个状态码。
   *
   * 为什么必须读文本而不是直接 response.json()：
   *   踩过一次 —— 报错只有一句 "JSON.parse: unexpected end of data at line 1 column 1"，
   *   完全看不出是 401 还是 200 空体、是鉴权问题还是网络问题。
   *   原因就是先 response.ok 再 json()，中间的失败全被压成同一句话。
   *   现在先取文本、再判断，空体时把状态码 / 内容类型 / 长度都带出来。
   */
  async function readFailure(response, bodyText) {
    const status = response.status;
    const type = response.headers.get("content-type") || "(未知)";
    let detail = "";
    if (bodyText) {
      try {
        const json = JSON.parse(bodyText);
        detail =
          json.Message ||
          json.message ||
          (json.error && (json.error.message || json.error.code)) ||
          bodyText.slice(0, 200);
      } catch {
        detail = bodyText.slice(0, 200);
      }
    }
    if (!bodyText) {
      detail =
        "服务端返回了空响应体（HTTP " +
        status +
        "，content-type: " +
        type +
        "）。可能是密钥无效、额度用尽，或该服务当前不可用。";
    }
    if (status === 401 || status === 403) {
      detail = detail + "（请检查密钥是否填写正确、是否有剩余额度）";
    }
    return new Error("HTTP " + status + "：" + detail);
  }

  /**
   * 统一按「文本 → 解析」处理响应。
   * @param {(json:any)=>any} onJson 解析成功后的取值函数
   */
  async function readJsonResponse(response, onJson) {
    const text = await response.text();
    if (!response.ok) throw await readFailure(response, text);
    if (!text) throw await readFailure(response, "");
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        "服务端返回的不是 JSON（HTTP " +
          response.status +
          "，content-type: " +
          (response.headers.get("content-type") || "未知") +
          "）：" +
          text.slice(0, 200),
      );
    }
    return onJson(json);
  }

  function bytesToBlob(bytes, type) {
    return new Blob([bytes], { type: type || DOCX_MIME });
  }

  /**
   * 请求未压缩的响应体。
   *
   * 为什么要显式指定：ConvertAPI 实测会返回 `content-encoding: gzip`（Node 探测时
   * 就是这个头）。跨域场景下浏览器解压压缩响应若出问题，response.text() 会拿到空串，
   * 报出来就是那句没头没尾的 "JSON.parse: unexpected end of data at line 1 column 1"
   * —— 完全看不出是解压失败。要求 identity 可以从源头绕开这类问题；
   * 证书文件本身不大，不压缩带来的流量差异可以忽略。
   */
  const NO_COMPRESSION = { "Accept-Encoding": "identity" };

  /* --------------------------------------------------------- 合批（多页 DOCX） */

  /**
   * 把 N 份单页证书拼成一份 N 页 DOCX。
   *
   * 为什么要这么做：
   *   1) 逐份转换会在前端留下 N 个单页 PDF，而 Word / Adobe 导出的 PDF 都是
   *      PDF 1.7 + 对象流（ObjStm）+ 交叉引用流，前端合并要么写个对象流解压器，
   *      要么引出 525KB 的 pdf-lib。合批之后这个问题根本不存在。
   *   2) Adobe 按「1 事务 = 1 份文档，最多 50 页」计费，合批把 N 次调用压成 1 次。
   *
   * 为什么可以这么拼：
   *   模板的 word/document.xml 里 <w:body> 只有两个一级子元素 ——
   *   一个 <w:p>（四组浮动文本框 + 整页背景图都挂在它里面）和一个 <w:sectPr>。
   *   又因为所有证书来自同一个模板，r:embed 关系 ID 指向的是同一张背景图，
   *   直接复用即可，不需要重编号关系、也不需要复制 media。
   *
   * ⚠ 必须显式插入分页符，不能指望背景图撑页。
   *   背景图是 <wp:anchor> **浮动**定位对象，不参与行内排版、不贡献段落高度，
   *   所以每个 <w:p> 在排版上都是空段。实测（ConvertAPI 转换出 15 份合批）：
   *   15 张证书全部叠在第 1 页，只有第一个人的姓名落在正确位置，其余被重绘覆盖。
   *   现在除第一份外，每份前面插入一个只含 <w:br w:type="page"/> 的段落，
   *   分页由显式指令决定，与浮动对象的高度无关。
   *
   * @param {Array<{name:string, documentXml:Uint8Array}>} documents
   *        **注意是 document.xml 的字节，不是整个 docx 包**（这个参数传错会报
   *        「缺少 <w:body>」，因为 zip 的二进制里当然没有 body 标签）。
   *        调用方用 cert-core 的 readZip 取出这一部件再传进来。
   * @returns {Uint8Array} 合并后的 document.xml 字节
   */
  function buildBatchDocx(documents) {
    if (!documents || !documents.length) throw new Error("没有可合批的证书。");

    const dec = new TextDecoder("utf-8");
    const parts = documents.map((item) => {
      if (!item.documentXml || !item.documentXml.length) {
        throw new Error(
          "证书 " + item.name + " 没有提供 document.xml 字节（需要先用 readZip 取出该部件）。",
        );
      }
      const xml = dec.decode(item.documentXml);
      const bodyMatch = xml.match(/<w:body>([\s\S]*)<\/w:body>/);
      if (!bodyMatch) throw new Error("证书 " + item.name + " 缺少 <w:body>。");
      const relMatch = xml.match(/r:embed="([^"]+)"/);
      const body = bodyMatch[1];
      const sectIndex = body.lastIndexOf("<w:sectPr");
      if (sectIndex < 0) throw new Error("证书 " + item.name + " 缺少 <w:sectPr>。");
      return {
        name: item.name,
        head: xml.slice(0, xml.indexOf("<w:body>")),
        body: body.slice(0, sectIndex),   // 去掉 sectPr，只留内容
        sectPr: body.slice(sectIndex),
        embed: relMatch ? relMatch[1] : "",
      };
    });

    const embeds = new Set(parts.map((part) => part.embed));
    if (embeds.size > 1) {
      throw new Error(
        "合批的证书来自不同模板（背景图引用不一致：" +
          Array.from(embeds).join(" / ") +
          "），无法合并。请分别生成。",
      );
    }

    const combined =
      parts[0].head +
      "<w:body>" +
      parts
        .map((part, index) =>
          index === 0
            ? part.body
            : // 显式分页：背景图是浮动对象，不撑段落高度，靠它翻页是不可靠的
              PAGE_BREAK_PARAGRAPH + part.body,
        )
        .join("") +
      parts[0].sectPr +      // 版式取第一份的，同模板下都一样
      "</w:body></w:document>";

    return new TextEncoder().encode(combined);
  }

  /**
   * 用 base 证书的 zip 结构承载拼好的 document.xml。
   * 其余部件（背景图、字体表、样式）全部沿用 base，因为模板相同。
   */
  async function repackWithDocumentXml(baseBytes, documentXmlBytes, readZip, writeZip) {
    const entries = await readZip(baseBytes);
    const output = entries.map((entry) =>
      entry.name === "word/document.xml"
        ? { name: entry.name, data: documentXmlBytes }
        : entry,
    );
    return writeZip(output);
  }

  /* ------------------------------------------------------------ ConvertAPI */

  /**
   * ConvertAPI：一次 POST 直接拿回 PDF，最省事。
   * 实测契约（假 key 探测）：
   *   POST https://v2.convertapi.com/convert/docx/to/pdf
   *   Authorization: Bearer <secret>
   *   multipart/form-data，字段名 File
   *   鉴权失败返回 401 {"Code":4011,"Message":"Unauthorized..."}
   * 成功时 body 是 JSON，Files[0].FileData 为 base64 的 PDF。
   */
  const convertApi = {
    id: "convertapi",
    label: "ConvertAPI",
    endpoint: "https://v2.convertapi.com/convert/docx/to/pdf",
    freeNote: "免费档约 250 次/月",
    credential: {
      key: "secret",
      label: "API Secret",
      placeholder: "粘贴 ConvertAPI 的 API Secret",
      help: "在 convertapi.com 注册后，控制台首页即可看到 API Secret。",
    },
    async convert({ bytes, filename, secret, signal }) {
      const form = new FormData();
      form.append("File", bytesToBlob(bytes), filename);
      const response = await fetchWithTimeout(
        this.endpoint,
        {
          method: "POST",
          headers: Object.assign({ Authorization: "Bearer " + secret }, NO_COMPRESSION),
          body: form,
        },
        DEFAULT_TIMEOUT_MS,
        signal,
      );
      return readJsonResponse(response, (payload) => {
        const first = payload && payload.Files && payload.Files[0];
        if (!first || !first.FileData) {
          throw new Error(
            "ConvertAPI 返回里没有 PDF 数据：" + JSON.stringify(payload).slice(0, 200),
          );
        }
        return { base64: first.FileData };
      });
    },
  };

  /* ---------------------------------------------------------- CloudConvert */

  /**
   * CloudConvert：建 job（导入 → 转换 → 导出），把文件 PUT 到预签名地址，
   * 轮询 job 状态，最后 GET 结果 URL。
   * 实测契约（假 key 探测）：
   *   POST https://api.cloudconvert.com/v2/jobs   Authorization: Bearer <token>
   *   鉴权失败返回 401 {"message":"Unauthenticated.","code":"UNAUTHENTICATED"}
   */
  const cloudConvert = {
    id: "cloudconvert",
    label: "CloudConvert",
    endpoint: "https://api.cloudconvert.com/v2",
    freeNote: "免费档 10 次/天",
    credential: {
      key: "token",
      label: "API Token",
      placeholder: "粘贴 CloudConvert 的 API Token",
      help: "在 cloudconvert.com 注册 → Dashboard → API Keys 创建 Token。",
    },
    async convert({ bytes, filename, token, signal, onStage }) {
      const base = this.endpoint;
      const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

      const createRes = await fetchWithTimeout(
        base + "/jobs",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            tasks: {
              "import-1": { operation: "import/upload" },
              "convert-1": { operation: "convert", input: "import-1", output_format: "pdf" },
              "export-1": { operation: "export/url", input: "convert-1" },
            },
            tag: filename,
          }),
        },
        DEFAULT_TIMEOUT_MS,
        signal,
      );
      if (!createRes.ok) throw await readFailure(createRes, await createRes.text());
      const job = (await createRes.json()).data;

      const uploadTask = job.tasks.find((task) => task.name === "import-1");
      if (!uploadTask || !uploadTask.result || !uploadTask.result.form) {
        throw new Error("CloudConvert 没有返回上传表单：" + JSON.stringify(job).slice(0, 200));
      }
      const form = uploadTask.result.form;
      const uploadBody = new FormData();
      Object.keys(form.fields).forEach((field) => uploadBody.append(field, form.fields[field]));
      uploadBody.append("file", bytesToBlob(bytes), filename);

      if (onStage) onStage("上传");
      const uploadRes = await fetchWithTimeout(
        form.url,
        { method: "POST", body: uploadBody },
        DEFAULT_TIMEOUT_MS,
        signal,
      );
      if (!uploadRes.ok) throw await readFailure(uploadRes, await uploadRes.text());

      // 轮询直到出现 finished 任务
      const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
      for (;;) {
        if (Date.now() > deadline) throw new Error("CloudConvert 转换超时。");
        await sleep(900);
        const pollRes = await fetchWithTimeout(
          base + "/jobs/" + job.id,
          { headers: { Authorization: "Bearer " + token } },
          DEFAULT_TIMEOUT_MS,
          signal,
        );
        if (!pollRes.ok) throw await readFailure(pollRes, await pollRes.text());
        const current = (await pollRes.json()).data;
        const failed = current.tasks.find((task) => task.status === "error");
        if (failed) {
          throw new Error(
            "CloudConvert 任务失败：" + (failed.message || failed.code || "未知原因"),
          );
        }
        const exportTask = current.tasks.find((task) => task.name === "export-1");
        if (exportTask && exportTask.status === "finished") {
          const file = exportTask.result.files[0];
          if (!file || !file.url) throw new Error("CloudConvert 没有返回下载地址。");
          if (onStage) onStage("下载");
          const fileRes = await fetchWithTimeout(file.url, {}, DEFAULT_TIMEOUT_MS, signal);
          if (!fileRes.ok) throw await readFailure(fileRes, await fileRes.text());
          return { bytes: new Uint8Array(await fileRes.arrayBuffer()) };
        }
      }
    },
  };

  /* ------------------------------------------------------ Adobe PDF Services */

  /**
   * Adobe PDF Services：换 access_token → 建 asset → 上传 S3 → 建 job → 轮询 → 下载。
   * 免费档 500 Document Transaction/月（1 事务 = 1 份文档，最多 50 页），额度最宽。
   *
   * ✅ 已用真实凭据端到端验证通过（2026-09）。下面三条是走通之前踩过的坑，
   *    改动这个适配器前请先读完 —— 每一条都会让整条链路失败。
   *
   * ⚠ 1) 令牌端点必须用 https://pdf-services.adobe.io/token，不是 Adobe IMS。
   *   踩过的坑：一开始照搬通用 Adobe IMS 凭据流程用了
   *     https://ims-na1.adobelogin.com/ims/token/v3
   *   结果一律返回 400 invalid_client —— 端点本身就错了。
   *   PDF Services 有独立的换令牌端点，且不需要 grant_type，只要这两个字段：
   *
   *     POST https://pdf-services.adobe.io/token
   *     Content-Type: application/x-www-form-urlencoded
   *     client_id=<Client ID>&client_secret=<Client Secret>
   *
   *   实测对比（假凭据，2026-09）：
   *     ims-na1…/ims/token/v3  → 400，且不带 Access-Control-Allow-Origin
   *                              （浏览器把它报成 CORS 失败，把 invalid_client 盖掉）
   *     pdf-services…/token    → 400，带 ACAO: *，错误信息能正常读到
   *
   * ⚠ 2) 不要给请求加自定义头。浏览器对非简单请求头会先发预检，预检没过就直接拦掉、
   *   请求到不了服务端。实测 /operation/createpdf 允许的头只有
   *     Authorization, Content-Type, X-Api-Key, User-Agent, If-Modified-Since, x-api-app-info
   *   曾因加了个 x-request-id 而报「not allowed by Access-Control-Allow-Headers」。
   *   注意：Node 的 fetch 不做预检，这类问题在 Node 侧永远测不出来。
   *
   * ⚠ 3) 上传与下载都是直连 Adobe 的 S3 预签名地址，CSP 的 connect-src 必须放行
   *   dcplatformstorageservice-prod-us-east-1.s3-accelerate.amazonaws.com（美国区）
   *   和 dcplatformstorageservice-prod-eu-west-1.s3.amazonaws.com（欧洲区）。
   *   （已实测两区预检均返回 ACAO: * 且允许 PUT。）
   *
   * Client Secret 会出现在前端，请用专门为此申请的应用凭据，不要复用其它系统的密钥。
   */
  const adobe = {
    id: "adobe",
    label: "Adobe PDF Services",
    endpoint: "https://pdf-services.adobe.io",
    tokenEndpoint: "https://pdf-services.adobe.io/token",
    freeNote: "免费档 500 份/月（额度最宽）",
    credential: {
      key: "adobe",
      label: "Client ID + Client Secret",
      fields: [
        { name: "clientId", label: "Client ID", placeholder: "粘贴 Client ID" },
        { name: "clientSecret", label: "Client Secret", placeholder: "粘贴 Client Secret", secret: true },
      ],
      help:
        "在 acrobatservices.adobe.com 走「PDF Services API」的凭据创建流程，" +
        "会下载一个 pdfservices-api-credentials.json，里面的 client_id / client_secret 就是这两项。" +
        "（注意不是 Adobe 开发者控制台里其它产品的凭据。）" +
        "客户端密钥会保存在本机浏览器中，请勿与本项目之外的密钥共用。",
    },
    async getToken({ clientId, clientSecret, signal }) {
      // 文档给的形态：只要这两个字段，没有 grant_type
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
      });
      const response = await fetchWithTimeout(
        this.tokenEndpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        },
        30000,
        signal,
      );
      if (!response.ok) throw await readFailure(response, await response.text());
      const json = await response.json();
      if (!json.access_token) throw new Error("Adobe 未返回 access_token。");
      return json.access_token;
    },
    async convert({ bytes, filename, clientId, clientSecret, signal, onStage }) {
      if (onStage) onStage("鉴权");
      const token = await this.getToken({ clientId, clientSecret, signal });
      const auth = { Authorization: "Bearer " + token, "x-api-key": clientId };

      if (onStage) onStage("创建资源");
      const assetRes = await fetchWithTimeout(
        this.endpoint + "/assets",
        {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, auth),
          body: JSON.stringify({ mediaType: DOCX_MIME }),
        },
        DEFAULT_TIMEOUT_MS,
        signal,
      );
      if (!assetRes.ok) throw await readFailure(assetRes, await assetRes.text());
      const asset = await assetRes.json();
      if (!asset || !asset.uploadUri || !asset.assetID) {
        throw new Error("Adobe 未返回上传地址：" + JSON.stringify(asset).slice(0, 200));
      }

      if (onStage) onStage("上传");
      const uploadRes = await fetchWithTimeout(
        asset.uploadUri,
        {
          method: "PUT",
          headers: { "Content-Type": DOCX_MIME },
          body: bytesToBlob(bytes),
        },
        DEFAULT_TIMEOUT_MS,
        signal,
      );
      if (!uploadRes.ok) throw await readFailure(uploadRes, await uploadRes.text());

      if (onStage) onStage("提交转换");
      const jobRes = await fetchWithTimeout(
        this.endpoint + "/operation/createpdf",
        {
          method: "POST",
          // ⚠ 不要加 x-request-id —— Adobe 的预检不允许这个头，浏览器会直接拦掉：
          //   "Request header field x-request-id is not allowed by
          //    Access-Control-Allow-Headers in preflight response"
          // 实测 createpdf 端点允许的头只有：
          //   Authorization, Content-Type, X-Api-Key, User-Agent,
          //   If-Modified-Since, x-api-app-info
          // 我们需要的三个（Authorization / Content-Type / X-Api-Key）都在其中。
          // Node 里探测发现不了这个问题 —— Node 的 fetch 不做 CORS 预检，照发不误；
          // 只有浏览器会拦。这就是为什么契约必须拿真实浏览器验证。
          headers: Object.assign({ "Content-Type": "application/json" }, auth),
          body: JSON.stringify({ assetID: asset.assetID }),
        },
        DEFAULT_TIMEOUT_MS,
        signal,
      );
      if (!jobRes.ok) throw await readFailure(jobRes, await jobRes.text());
      const location = jobRes.headers.get("location");
      if (!location) {
        throw new Error(
          "Adobe 未返回任务地址（location）。注意 location 属于非「简单响应头」，" +
            "若 CSP 或服务端未放行 Access-Control-Expose-Headers，浏览器会读不到它。",
        );
      }

      const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
      for (;;) {
        if (Date.now() > deadline) throw new Error("Adobe 转换超时。");
        await sleep(1200);
        const pollRes = await fetchWithTimeout(
          location,
          { headers: auth },
          DEFAULT_TIMEOUT_MS,
          signal,
        );
        if (!pollRes.ok) throw await readFailure(pollRes, await pollRes.text());
        const status = await pollRes.json();
        if (status.status === "failed") {
          const reason = status.error && status.error.message;
          throw new Error("Adobe 转换失败：" + (reason || "未知原因"));
        }
        if (status.status === "done") {
          const uri = status.asset && status.asset.downloadUri;
          if (!uri) throw new Error("Adobe 任务完成但没有下载地址。");
          if (onStage) onStage("下载");
          const fileRes = await fetchWithTimeout(uri, {}, DEFAULT_TIMEOUT_MS, signal);
          if (!fileRes.ok) throw await readFailure(fileRes, await fileRes.text());
          return { bytes: new Uint8Array(await fileRes.arrayBuffer()) };
        }
      }
    },
  };

  const PROVIDERS = [convertApi, cloudConvert, adobe];

  function getProvider(id) {
    return PROVIDERS.find((provider) => provider.id === id) || null;
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  /**
   * 把服务商返回的结果统一成 Uint8Array。
   * ConvertAPI 给 base64，其余给字节；这里收敛掉差异。
   */
  function normalizeResult(result) {
    if (result.bytes) return result.bytes;
    if (result.base64) return base64ToBytes(result.base64);
    throw new Error("转换结果为空。");
  }

  /**
   * 批量转换 —— 默认逐份，每人一个 PDF 文件。
   *
   * 为什么默认逐份（而不是合批）：
   *   证书是发给个人的，**每个人要拿到自己那一张 PDF**，
   *   文件名形如 `TE操作培训证书_姓名.pdf`。合成一本多页 PDF 再发下去，
   *   收件人还得自己找自己那页 —— 实际使用中客户不接受。
   *   逐份转换天然就是这个结果，而且单份失败可以只重试那一份。
   *
   * 合批（N 份拼成一份 N 页 DOCX，一次请求换回一份多页 PDF）作为**可选项**保留：
   *   Adobe 按「1 事务 = 1 份文档，最多 50 页」计费，合批把 N 次调用压成 1 次，
   *   所以要归档一本合订本、或想省额度时可以用。
   *   注意合批需要 documentXml（由 readZip 取出），逐份只需要 docx。
   *
   * @param {object} options
   * @param {Array<{name:string, docx:Uint8Array, documentXml?:Uint8Array}>} options.items
   *        docx 是必填；documentXml 只在 batch=true 时需要。
   * @param {string} options.providerId 服务商 id
   * @param {object} options.credentials 凭据（按服务商不同）
   * @param {boolean} [options.batch=false] 是否合成一本多页 PDF（默认否）
   * @param {Function} [options.readZip] cert-core 的 readZip（batch 时需要）
   * @param {Function} [options.writeZip] cert-core 的 writeZip（batch 时需要）
   * @param {AbortSignal} [options.signal]
   * @param {(info:object)=>void} [options.onProgress]
   * @returns {Promise<{pdfList:Array, failed:Array, batched:boolean}>}
   */
  async function convertBatch(options) {
    const { items, providerId, credentials, signal, onProgress, readZip, writeZip } = options;
    const batch = options.batch === true;
    const provider = getProvider(providerId);
    if (!provider) throw new Error("未知的转换服务：" + providerId);
    if (!items.length) throw new Error("没有待转换的证书。");
    if (items.length > MAX_BATCH) {
      throw new Error(
        `一次最多转换 ${MAX_BATCH} 份，当前 ${items.length} 份。请勾选后分批转换。`,
      );
    }

    const failed = [];
    const pdfList = [];

    const speak = (info) => onProgress && onProgress(info);

    /** 校验拿到的确实是 PDF，别把坏文件塞给用户。 */
    const assertPdf = (bytes, label) => {
      if (!bytes || bytes.length < 5 || bytes[0] !== 0x25 || bytes[1] !== 0x50) {
        throw new Error((label ? label + "：" : "") + "返回内容不是有效的 PDF。");
      }
      return bytes;
    };

    if (batch && items.length > 1) {
      // 合批需要 documentXml（由 readZip 取出）与 zip 读写函数。
      // 缺了就明确报错，而不是拿着 undefined 去拼、产出一份坏文档。
      if (typeof readZip !== "function" || typeof writeZip !== "function") {
        throw new Error("合批需要 readZip / writeZip（来自 cert-core）。");
      }
      const missingXml = items.filter((item) => !item.documentXml || !item.documentXml.length);
      if (missingXml.length) {
        throw new Error(
          "合批需要每份证书的 document.xml 字节，但 " +
            missingXml.length +
            " 份缺少（如「" +
            (missingXml[0].name || "?") +
            "」）。请改用逐份转换。",
        );
      }
      try {
        const combinedXml = buildBatchDocx(
          items.map((item) => ({ name: item.name, documentXml: item.documentXml })),
        );
        // 用第一份证书的 zip 结构承载拼好的 document.xml：
        // 同模板下背景图、字体表、样式都相同，只需换掉这一个部件。
        const combined = await repackWithDocumentXml(
          items[0].docx,
          combinedXml,
          readZip,
          writeZip,
        );
        speak({ done: 0, total: 1, stage: `合批 ${items.length} 份为一份多页文档` });
        const result = await provider.convert({
          bytes: combined,
          filename: "TE操作培训证书_合批.docx",
          signal,
          onStage: (stage) => speak({ done: 0, total: 1, stage }),
          ...credentials,
        });
        pdfList.push({
          name: `TE操作培训证书_${items.length}份`,
          // 合批产物是一本合订本，文件名不带个人姓名
          fileName: null,
          bytes: assertPdf(normalizeResult(result)),
        });
        speak({ done: 1, total: 1, stage: "完成" });
        return { pdfList: pdfList, failed: failed, batched: true };
      } catch (error) {
        if (signal && signal.aborted) throw error;
        // 合批失败就退回逐份，并把原因记下来供用户判断
        failed.push({
          name: "（合批）",
          error: (error.message || String(error)) + " —— 已自动改为逐份转换",
        });
        speak({ done: 0, total: items.length, stage: "合批失败，改为逐份转换" });
      }
    }

    const total = items.length;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (signal && signal.aborted) {
        for (let rest = index; rest < items.length; rest += 1) {
          failed.push({ name: items[rest].name, error: "已取消" });
        }
        break;
      }
      speak({ done: index, total: total, name: item.name, stage: "开始" });
      try {
        const result = await provider.convert({
          bytes: item.docx || item.bytes,
          filename: item.name + ".docx",
          signal,
          onStage: (stage) => speak({ done: index, total: total, name: item.name, stage }),
          ...credentials,
        });
        pdfList.push({
          // fileName 由调用方给出（形如 TE操作培训证书_姓名.pdf），
          // 这样同名重复的 _2、_3 后缀也能保住，不会被覆盖
          name: item.name,
          fileName: item.fileName || null,
          bytes: assertPdf(normalizeResult(result), item.name),
        });
        speak({ done: index + 1, total: total, name: item.name, stage: "完成" });
      } catch (error) {
        failed.push({ name: item.name, error: error.message || String(error) });
        speak({ done: index + 1, total: total, name: item.name, stage: "失败" });
      }
    }

    return { pdfList: pdfList, failed: failed, batched: false };
  }

  return {
    PROVIDERS: PROVIDERS,
    MAX_BATCH: MAX_BATCH,
    getProvider: getProvider,
    convertBatch: convertBatch,
    buildBatchDocx: buildBatchDocx,
    repackWithDocumentXml: repackWithDocumentXml,
    base64ToBytes: base64ToBytes,
  };
});
