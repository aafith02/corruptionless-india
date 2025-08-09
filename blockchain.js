const crypto = require('crypto');
const vm = require('vm');

class CryptoUtil {
  static sha256(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
  }
  static hmac(key, msg) {
    return crypto.createHmac('sha256', key).update(msg).digest('hex');
  }
}

class Block {
  constructor(index, previousHash, timestamp, data, validatorId, signature) {
    this.index = index;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
    this.data = data; // array of transactions
    this.validatorId = validatorId; // who signed/validated this block
    this.signature = signature; // validator's HMAC signature
    this.hash = this.calculateHash();
  }
  calculateHash() {
    return CryptoUtil.sha256(
      this.index + this.previousHash + this.timestamp + JSON.stringify(this.data) + this.validatorId + this.signature
    );
  }
}

class Transaction {
  constructor(from, to, payload, type = 'transfer') {
    this.from = from;
    this.to = to;
    this.payload = payload; // for contracts this is {contract, method, args}
    this.type = type; // 'transfer' or 'contract'
    this.timestamp = Date.now();
    this.id = CryptoUtil.sha256(from + to + JSON.stringify(payload) + this.timestamp);
  }
}

class SimpleContractManager {
  constructor() {
    this.contracts = new Map(); // address -> {code, state}
  }
  deploy(deployer, sourceCode) {
    const address = CryptoUtil.sha256(deployer + sourceCode + Date.now()).slice(0, 40);
    const state = {};
    const contract = { code: sourceCode, state };
    this.contracts.set(address, contract);
    return address;
  }
  async execute(address, method, args, context = {}) {
    const c = this.contracts.get(address);
    if (!c) throw new Error('contract not found');
    const sandbox = {
      state: c.state,
      args,
      console,
      result: null,
      emit: (event, payload) => {
        if (!sandbox._events) sandbox._events = [];
        sandbox._events.push({ event, payload });
      }
    };
    const script = `(async function(){ if(typeof contract === 'undefined') contract = {};
      ${c.code}
      if(typeof contract['${method}']!=='function') throw new Error('method not found');
      result = await contract['${method}'](...args);
    })()`;
    vm.createContext(sandbox);
    const s = new vm.Script(script);
    await s.runInContext(sandbox, { timeout: 1000 });
    return { result: sandbox.result, events: sandbox._events || [] };
  }
}

class Blockchain {
  constructor(validators = []) {
    this.chain = [];
    this.pendingTransactions = [];
    this.validators = new Map(); // validatorId -> {pubKey, secret (for demo)}
    validators.forEach(v => this.addValidator(v.id, v.secret));
    this.contracts = new SimpleContractManager();
    this.createGenesisBlock();
  }
  createGenesisBlock() {
    const g = new Block(0, '0', Date.now(), [{ type: 'genesis' }], 'genesis', 'genesis');
    this.chain.push(g);
  }
  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }
  addValidator(id, secret) {
    this.validators.set(id, { secret });
  }
  removeValidator(id) {
    this.validators.delete(id);
  }
  createTransaction(tx) {
    this.pendingTransactions.push(tx);
  }
  signBlockPayload(index, previousHash, timestamp, data, validatorId) {
    const payload = index + previousHash + timestamp + JSON.stringify(data) + validatorId;
    const v = this.validators.get(validatorId);
    if (!v) throw new Error('unknown validator');
    return CryptoUtil.hmac(v.secret, payload);
  }
  validateBlockSignature(block) {
    const v = this.validators.get(block.validatorId);
    if (!v) return false;
    const payload = block.index + block.previousHash + block.timestamp + JSON.stringify(block.data) + block.validatorId;
    const expected = CryptoUtil.hmac(v.secret, payload);
    return expected === block.signature;
  }
  mineBlock(validatorId) {
    if (!this.validators.has(validatorId)) throw new Error('not a validator');
    const index = this.chain.length;
    const previousHash = this.getLatestBlock().hash;
    const timestamp = Date.now();
    const data = this.pendingTransactions.splice(0, 100); // batch up to 100
    const signature = this.signBlockPayload(index, previousHash, timestamp, data, validatorId);
    const block = new Block(index, previousHash, timestamp, data, validatorId, signature);
    if (this.addBlock(block)) return block;
    throw new Error('failed to add block');
  }
  addBlock(block) {
    const latest = this.getLatestBlock();
    if (block.previousHash !== latest.hash) return false;
    if (!this.validateBlockSignature(block)) return false;
    if (block.hash !== block.calculateHash()) return false;
    this.chain.push(block);
    this.applyBlockData(block.data);
    return true;
  }
  applyBlockData(txs) {
    for (const tx of txs) {
      if (tx.type === 'contract') {
        const { contract, method, args } = tx.payload;
        this.contracts.execute(contract, method, args).catch(e => console.error('contract err', e));
      }
    }
  }
  isValidChain(chain) {
    if (JSON.stringify(chain[0]) !== JSON.stringify(this.chain[0])) return false;
    for (let i = 1; i < chain.length; i++) {
      const current = chain[i];
      const prev = chain[i - 1];
      const blockObj = new Block(current.index, current.previousHash, current.timestamp, current.data, current.validatorId, current.signature);
      if (blockObj.hash !== current.hash) return false;
      if (prev.hash !== current.previousHash) return false;
      if (!this.validateBlockSignature(current)) return false;
    }
    return true;
  }
  resolveConflicts(peerChains) {
    const validChains = peerChains.filter(c => this.isValidChain(c));
    if (validChains.length === 0) return false;
    validChains.sort((a, b) => b.length - a.length);
    const newChain = validChains[0];
    if (newChain.length > this.chain.length) {
      this.chain = newChain.map(b => new Block(b.index, b.previousHash, b.timestamp, b.data, b.validatorId, b.signature));
      return true;
    }
    return false;
  }
}

module.exports = { Blockchain, Block, Transaction, SimpleContractManager };
