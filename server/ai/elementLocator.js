/**
 * AI 元素定位模块
 * 
 * 功能：
 * - UI 节点特征提取
 * - 文本相似度匹配
 * - 元素候选排序和筛选
 * - 定位自信度评估
 */

const crypto = require('crypto');

/**
 * 简单的文本相似度计算（基于编辑距离）
 * @param {string} a
 * @param {string} b
 * @returns {number} 相似度 (0.0-1.0)
 */
function textSimilarity(a, b) {
  if (!a || !b) return 0;
  
  a = String(a).toLowerCase().trim();
  b = String(b).toLowerCase().trim();
  
  if (a === b) return 1.0;
  
  // 计算莱文斯坦距离
  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  
  return 1.0 - (distance / maxLen);
}

/**
 * 莱文斯坦距离（编辑距离）
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshteinDistance(a, b) {
  const len1 = a.length;
  const len2 = b.length;
  const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(0));
  
  for (let i = 0; i <= len1; i++) matrix[0][i] = i;
  for (let j = 0; j <= len2; j++) matrix[j][0] = j;
  
  for (let j = 1; j <= len2; j++) {
    for (let i = 1; i <= len1; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,      // 插入
        matrix[j - 1][i] + 1,      // 删除
        matrix[j - 1][i - 1] + indicator  // 替换
      );
    }
  }
  
  return matrix[len2][len1];
}

/**
 * 计算两个向量的余弦相似度
 * @param {number[]} vec1
 * @param {number[]} vec2
 * @returns {number}
 */
function cosineSimilarity(vec1, vec2) {
  if (vec1.length !== vec2.length || vec1.length === 0) {
    return 0;
  }
  
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;
  
  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }
  
  if (norm1 === 0 || norm2 === 0) return 0;
  
  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

/**
 * 提取 UI 节点的特征向量（基于文本关键字）
 * @param {Object} node UI 节点 { text, resourceId, className }
 * @returns {Object} { keywords, features }
 */
function extractNodeFeatures(node) {
  const features = {
    keywords: [],
    hasText: false,
    hasResourceId: false,
    textLength: 0,
  };
  
  if (node.text) {
    features.keywords.push(node.text.toLowerCase().trim());
    features.hasText = true;
    features.textLength = node.text.length;
  }
  
  if (node.resourceId) {
    // 分解 resource ID 的组成部分
    const parts = node.resourceId.split(/[/_:-]+/);
    parts.forEach(p => {
      if (p.length > 1) {
        features.keywords.push(p.toLowerCase());
      }
    });
    features.hasResourceId = true;
  }
  
  if (node.className) {
    // 从类名提取：Button, EditText 等
    const match = node.className.match(/[A-Z][a-z]+/g);
    if (match) {
      match.forEach(m => features.keywords.push(m.toLowerCase()));
    }
  }
  
  return features;
}

/**
 * 计算节点与查询的匹配分数
 * @param {Object} node UI 节点
 * @param {string} query 查询字符串（如 "确定按钮"）
 * @returns {number} 匹配分数 (0.0-1.0)
 */
function computeNodeScore(node, query) {
  let score = 0;
  const weights = {
    textMatch: 0.6,        // 直接文本匹配权重最高
    resourceIdMatch: 0.25,
    partialMatch: 0.15,
  };
  
  // 1. 直接文本匹配
  if (node.text) {
    const textSim = textSimilarity(node.text, query);
    score += textSim * weights.textMatch;
  }
  
  // 2. Resource ID 匹配
  if (node.resourceId) {
    const parts = node.resourceId.split(/[/_:-]+/);
    const bestPartMatch = parts.reduce((max, part) => {
      return Math.max(max, textSimilarity(part, query));
    }, 0);
    score += bestPartMatch * weights.resourceIdMatch;
  }
  
  // 3. 部分匹配（查询包含在文本中）
  if (node.text && query.length > 1) {
    const text = node.text.toLowerCase();
    const q = query.toLowerCase();
    if (text.includes(q)) {
      score += 0.3 * weights.partialMatch;
    }
  }
  
  // 4. 可点击性奖励
  if (node.clickable) {
    score *= 1.1;
  }
  
  return Math.min(score, 1.0);
}

/**
 * AI 元素定位器
 */
class ElementLocator {
  constructor() {
    this.cache = new Map();  // 缓存最近的查询结果
    this.cacheMaxAge = 30000; // 30 秒
  }
  
  /**
   * 在 UI 树中定位元素
   * @param {string} query 查询文本（如 "确定按钮"）
   * @param {Array} nodes UI 节点数组
   * @param {Object} options { minConfidence, maxResults, strategy }
   * @returns {Array} 匹配结果数组 (降序排列)
   */
  locate(query, nodes, options = {}) {
    const {
      minConfidence = 0.5,
      maxResults = 10,
      strategy = 'best-match', // 'best-match' | 'all-above-threshold'
    } = options;
    
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return [];
    }
    
    // 计算每个节点的匹配分数
    const candidates = nodes
      .map((node, idx) => ({
        nodeId: node.nodeId || idx,
        text: node.text || '',
        bounds: {
          left: node.left || 0,
          top: node.top || 0,
          right: node.right || 0,
          bottom: node.bottom || 0,
        },
        resourceId: node.resourceId || '',
        className: node.className || '',
        clickable: node.clickable !== false,
        confidence: computeNodeScore(node, query),
      }))
      .filter(c => c.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
    
    // 根据策略返回结果
    if (strategy === 'best-match' && candidates.length > 0) {
      return candidates.slice(0, maxResults);
    }
    
    return candidates.slice(0, maxResults);
  }
  
  /**
   * 批量定位多个元素
   * @param {Array<string>} queries 查询列表
   * @param {Array} nodes UI 节点数组
   * @returns {Object} { query -> results }
   */
  locateBatch(queries, nodes) {
    const results = {};
    
    for (const query of queries) {
      results[query] = this.locate(query, nodes, {
        minConfidence: 0.5,
        maxResults: 3,
      });
    }
    
    return results;
  }
  
  /**
   * 根据地理位置查找节点（用于屏幕上的点击）
   * @param {number} x 屏幕坐标 X
   * @param {number} y 屏幕坐标 Y
   * @param {Array} nodes UI 节点数组
   * @returns {Array} 包含该点的节点列表
   */
  locateByPoint(x, y, nodes) {
    if (!Array.isArray(nodes)) return [];
    
    return nodes
      .filter(node => {
        const left = node.left || 0;
        const top = node.top || 0;
        const right = node.right || 0;
        const bottom = node.bottom || 0;
        
        return x >= left && x <= right && y >= top && y <= bottom;
      })
      .map((node, idx) => ({
        nodeId: node.nodeId || idx,
        text: node.text || '',
        resourceId: node.resourceId || '',
        bounds: {
          left: node.left,
          top: node.top,
          right: node.right,
          bottom: node.bottom,
        },
      }));
  }
  
  /**
   * 获取缓存的结果
   * @param {string} cacheKey
   * @returns {Object|null}
   */
  getCached(cacheKey) {
    const cached = this.cache.get(cacheKey);
    if (!cached) return null;
    
    const age = Date.now() - cached.timestamp;
    if (age > this.cacheMaxAge) {
      this.cache.delete(cacheKey);
      return null;
    }
    
    return cached.result;
  }
  
  /**
   * 设置缓存
   * @param {string} cacheKey
   * @param {Object} result
   */
  setCached(cacheKey, result) {
    this.cache.set(cacheKey, {
      result,
      timestamp: Date.now(),
    });
  }
  
  /**
   * 清空缓存
   */
  clearCache() {
    this.cache.clear();
  }
}

/**
 * UI 变化检测器
 * 用于追踪 UI 树的变化，检测页面转换
 */
class UIChangeDetector {
  constructor() {
    this.previousTree = null;
    this.changeHistory = [];
    this.maxHistorySize = 50;
  }
  
  /**
   * 检测 UI 树的变化
   * @param {Array} nodes 当前 UI 节点数组
   * @returns {Object} { changed, addedNodes, removedNodes, modifiedNodes }
   */
  detectChange(nodes) {
    if (!this.previousTree) {
      this.previousTree = nodes;
      return { changed: true, isFirstTime: true };
    }
    
    const previousIds = new Set(
      this.previousTree.map(n => n.nodeId || JSON.stringify(n.bounds))
    );
    const currentIds = new Set(
      nodes.map(n => n.nodeId || JSON.stringify(n.bounds))
    );
    
    const addedNodes = [];
    const removedNodes = [];
    
    nodes.forEach(node => {
      const id = node.nodeId || JSON.stringify(node.bounds);
      if (!previousIds.has(id)) {
        addedNodes.push(node);
      }
    });
    
    this.previousTree.forEach(node => {
      const id = node.nodeId || JSON.stringify(node.bounds);
      if (!currentIds.has(id)) {
        removedNodes.push(node);
      }
    });
    
    const changed = addedNodes.length > 0 || removedNodes.length > 0;
    
    const changeRecord = {
      timestamp: Date.now(),
      changed,
      addedNodesCount: addedNodes.length,
      removedNodesCount: removedNodes.length,
    };
    
    this.changeHistory.push(changeRecord);
    if (this.changeHistory.length > this.maxHistorySize) {
      this.changeHistory.shift();
    }
    
    this.previousTree = nodes;
    
    return {
      changed,
      addedNodes,
      removedNodes,
      changeRecord,
    };
  }
  
  /**
   * 获取变化历史
   * @returns {Array}
   */
  getHistory() {
    return this.changeHistory;
  }
  
  /**
   * 重置状态
   */
  reset() {
    this.previousTree = null;
    this.changeHistory = [];
  }
}

module.exports = {
  // 文本处理
  textSimilarity,
  levenshteinDistance,
  cosineSimilarity,
  
  // 节点特征
  extractNodeFeatures,
  computeNodeScore,
  
  // 定位器类
  ElementLocator,
  UIChangeDetector,
};
