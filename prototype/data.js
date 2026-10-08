/**
 * 模拟数据层
 * 三部分：
 *   1. history7d —— Agent2 / Agent3 需要的过去 7 天历史信号库
 *   2. batches   —— 待分析的多渠道反馈批次（含 customer_ref，用于跨渠道关联）
 *   3. 渠道配色
 */

window.VOC_DATA = {
  // 过去 7 天各标签的反馈量与情感分布，作为 Agent2 判断「偶发」还是「扩散」的基线
  history7d: {
    "质量问题": { total: 14, negative: 11, trend: "上升" },
    "物流问题": { total: 9, negative: 5, trend: "平稳" },
    "服务问题": { total: 6, negative: 2, trend: "下降" },
    "尺寸问题": { total: 4, negative: 3, trend: "平稳" },
    "色差问题": { total: 3, negative: 2, trend: "平稳" },
    "包装问题": { total: 5, negative: 3, trend: "上升" },
    "价格问题": { total: 7, negative: 2, trend: "平稳" },
    "其他": { total: 11, negative: 3, trend: "平稳" }
  },

  // 过去 24 小时的同类差评数，用于触发 Agent2 的「≥5 条即高优先级」规则
  // 让三级风险都可被触发：质量问题落在「高」区，包装问题落在「观察」区，其余落在「常规」区
  recent24hNegative: {
    "质量问题": 6,
    "包装问题": 4,
    "物流问题": 2,
    "色差问题": 1,
    "尺寸问题": 0,
    "服务问题": 0,
    "价格问题": 0,
    "其他": 0
  },

  presetLabels: ["质量问题", "物流问题", "服务问题", "尺寸问题", "色差问题", "包装问题", "价格问题", "其他"],

  labelColors: {
    "质量问题": "#E05140",
    "物流问题": "#7FA8CE",
    "服务问题": "#C48BB6",
    "尺寸问题": "#B08968",
    "色差问题": "#C9A75E",
    "包装问题": "#8FBF9F",
    "价格问题": "#A0A8B8",
    "其他": "#7C8479"
  },

  batches: [
    {
      id: "A",
      name: "便携榨汁杯",
      scope: "近 5 天 · 3 个渠道",
      expectation: "同一用户跨渠道矛盾应被交叉验证；充电口问题在 24 小时内差评达 6 条，应触发高优先级",
      feedbacks: [
        { id: "F001", channel: "评价", customer_ref: "U2043", product: "便携榨汁杯", time: "2026-09-28", text: "用了两天充电口就松了，根本没法用，充着电稍微碰一下就断，已经不敢用了" },
        { id: "F002", channel: "客服对话", customer_ref: "U2043", product: "便携榨汁杯", time: "2026-09-28", text: "我这个杯子才用两天就充不进电了，插上去一点反应都没有，这算质量问题吧？我不想换货，直接退款行不行" },
        { id: "F003", channel: "退款说明", customer_ref: "U2043", product: "便携榨汁杯", time: "2026-09-29", text: "不喜欢" },
        { id: "F004", channel: "评价", customer_ref: "U2091", product: "便携榨汁杯", time: "2026-09-29", text: "充电口很松，稍微晃一下就断电，做工太差了，用了一周不到就这样" },
        { id: "F005", channel: "客服对话", customer_ref: "U2210", product: "便携榨汁杯", time: "2026-10-01", text: "买回来第三天就充不上电了，问客服只说让我自己联系厂家，太气人了" },
        { id: "F006", channel: "评价", customer_ref: "U2077", product: "便携榨汁杯", time: "2026-09-27", text: "杯子挺好用的，榨汁很快，就是声音有点大，这个能接受" },
        { id: "F007", channel: "评价", customer_ref: "U2150", product: "便携榨汁杯", time: "2026-09-30", text: "第二次买了，上一台也是充电口松，这台还是老毛病，是不是批次有问题" },
        { id: "F008", channel: "评价", customer_ref: "U2033", product: "便携榨汁杯", time: "2026-09-26", text: "物流太慢了，等了六天才到，东西还没拆" },
        { id: "F009", channel: "评价", customer_ref: "U2088", product: "便携榨汁杯", time: "2026-10-02", text: "榨汁效果不错，性价比高，推荐给同事了" }
      ]
    },
    {
      id: "B",
      name: "儿童保温杯",
      scope: "近 5 天 · 含安全类信号",
      expectation: "开盖喷溅涉及烫伤，属安全类，必须触发高优先级与人工复核；「过敏」需单独判定",
      feedbacks: [
        { id: "F010", channel: "评价", customer_ref: "U3001", product: "儿童保温杯", time: "2026-10-01", text: "新买的保温杯一拧开盖子就往外喷，我们这边都管这叫爆盖，孩子被热水烫到手了，太危险了" },
        { id: "F011", channel: "客服对话", customer_ref: "U3022", product: "儿童保温杯", time: "2026-10-02", text: "杯盖的泄压阀好像坏了，装热水拧紧之后还是会漏，孩子书包里全湿了，差点烫到" },
        { id: "F012", channel: "评价", customer_ref: "U3010", product: "儿童保温杯", time: "2026-09-30", text: "保温杯颜值很高，孩子很喜欢，保温效果也不错" },
        { id: "F013", channel: "退款说明", customer_ref: "U3033", product: "儿童保温杯", time: "2026-10-02", text: "孩子用了过敏" },
        { id: "F014", channel: "评价", customer_ref: "U3044", product: "儿童保温杯", time: "2026-10-03", text: "保温效果一般，早上装的热水中午就温了，不过价格便宜还能接受" },
        { id: "F015", channel: "售后申请", customer_ref: "U3066", product: "儿童保温杯", time: "2026-10-02", text: "杯盖拧紧之后还是漏水，申请换货，孩子上学带着不方便" },
        { id: "F016", channel: "评价", customer_ref: "U3055", product: "儿童保温杯", time: "2026-09-29", text: "发货很快，包装完好，好评" }
      ]
    },
    {
      id: "C",
      name: "常规批次",
      scope: "近 5 天 · 噪声对照组",
      expectation: "正确做法是几乎不出高优先级信号，用来检验误报率",
      feedbacks: [
        { id: "F017", channel: "评价", customer_ref: "U4001", product: "便携榨汁杯", time: "2026-10-01", text: "一般般吧，不好不坏" },
        { id: "F018", channel: "评价", customer_ref: "U4002", product: "便携榨汁杯", time: "2026-10-01", text: "东西还行，就是快递小哥态度不好，送到楼下就不肯上来了" },
        { id: "F019", channel: "评价", customer_ref: "U4003", product: "儿童保温杯", time: "2026-10-02", text: "和图片有点色差，实物偏暗，不过能接受" },
        { id: "F020", channel: "客服对话", customer_ref: "U4004", product: "儿童保温杯", time: "2026-10-02", text: "这个材质是不是食品级的？孩子用我比较担心" },
        { id: "F021", channel: "退款说明", customer_ref: "U4005", product: "便携榨汁杯", time: "2026-10-03", text: "拍错了" },
        { id: "F022", channel: "评价", customer_ref: "U4006", product: "便携榨汁杯", time: "2026-10-03", text: "什么时候发货？都三天了还没动静" },
        { id: "F023", channel: "评价", customer_ref: "U4007", product: "便携榨汁杯", time: "2026-10-03", text: "加V同款工厂出货，比这家便宜一半，需要的私信" },
        { id: "F024", channel: "评价", customer_ref: "U4008", product: "儿童保温杯", time: "2026-10-04", text: "第二次回购了，还是一样好用" },
        { id: "F025", channel: "评价", customer_ref: "U4009", product: "儿童保温杯", time: "2026-10-04", text: "收到了，还没用，先给个五星" }
      ]
    }
  ],

  channelColors: {
    "评价": "#7FA8CE",
    "客服对话": "#C48BB6",
    "退款说明": "#C9A75E",
    "售后申请": "#8FBF9F"
  }
};



