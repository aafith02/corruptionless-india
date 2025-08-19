<<<<<<< HEAD
const crypto = require('crypto');

class Block {
    constructor(index, timestamp, data, previousHash = '') {
        this.index = index;
        this.timestamp = timestamp;
        this.data = data;
        this.previousHash = previousHash;
        this.hash = this.calculateHash();
        this.nonce = 0;
    }

    calculateHash() {
        return crypto.createHash('sha256')
            .update(this.index + this.previousHash + this.timestamp + JSON.stringify(this.data) + this.nonce)
            .digest('hex');
    }

    mineBlock(difficulty) {
        while (this.hash.substring(0, difficulty) !== Array(difficulty + 1).join("0")) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
    }
}

class Node {
    constructor(id, totalNodes, faultyNodes) {
        this.id = id;
        this.blockchain = [this.createGenesisBlock()];
        this.peers = [];
        this.totalNodes = totalNodes;
        this.faultyNodes = faultyNodes;
        this.f = faultyNodes;
        this.sequenceNumber = 0;
        this.state = 'NORMAL';
        this.prePrepareMessages = {};
        this.prepareMessages = {};
        this.commitMessages = {};
    }

    createGenesisBlock() {
        return new Block(0, Date.now(), "Genesis Block", "0");
    }

    addPeer(node) {
        this.peers.push(node);
    }

    simulateFailure() {
        this.state = 'FAULTY';
    }

    prePrepare(block) {
        if (this.state === 'FAULTY') return;
        this.sequenceNumber++;
        const message = {
            type: 'PRE-PREPARE',
            view: 0,
            sequenceNumber: this.sequenceNumber,
            block: block,
            nodeId: this.id
        };
        this.multicast(message);
    }

    prepare(message) {
        if (this.state === 'FAULTY') return;
        const { sequenceNumber, block } = message;

        if (!this.prePrepareMessages[sequenceNumber]) {
            this.prePrepareMessages[sequenceNumber] = [];
        }

        if (!this.prePrepareMessages[sequenceNumber].some(msg => msg.nodeId === message.nodeId)) {
            this.prePrepareMessages[sequenceNumber].push(message);
        }

        const prepareMessage = {
            type: 'PREPARE',
            view: 0,
            sequenceNumber: sequenceNumber,
            blockHash: block.hash,
            nodeId: this.id
        };

        this.multicast(prepareMessage);
    }

    commit(message) {
        if (this.state === 'FAULTY') return;
        const { sequenceNumber, blockHash } = message;

        if (!this.prepareMessages[sequenceNumber]) {
            this.prepareMessages[sequenceNumber] = [];
        }

        if (!this.prepareMessages[sequenceNumber].some(msg => msg.nodeId === message.nodeId)) {
            this.prepareMessages[sequenceNumber].push(message);
        }

        const commitMessage = {
            type: 'COMMIT',
            view: 0,
            sequenceNumber: sequenceNumber,
            blockHash: blockHash,
            nodeId: this.id
        };
        this.multicast(commitMessage);
    }

    processCommit(message) {
        if (this.state === 'FAULTY') return;
        const { sequenceNumber, blockHash } = message;

        if (!this.commitMessages[sequenceNumber]) {
            this.commitMessages[sequenceNumber] = [];
        }

        if (!this.commitMessages[sequenceNumber].some(msg => msg.nodeId === message.nodeId)) {
            this.commitMessages[sequenceNumber].push(message);
        }

        const commitCount = this.commitMessages[sequenceNumber].filter(m => m.blockHash === blockHash).length;
        if (commitCount >= 2 * this.f + 1) {
            const block = this.prePrepareMessages[sequenceNumber][0].block;
            if (this.isValidNewBlock(block, this.getLatestBlock())) {
                this.blockchain.push(block);
                this.prePrepareMessages[sequenceNumber] = [];
                this.prepareMessages[sequenceNumber] = [];
                this.commitMessages[sequenceNumber] = [];
            }
        }
    }

    multicast(message) {
        this.peers.forEach(peer => {
            if (peer.id !== this.id) peer.receiveMessage(message);
        });
    }

    receiveMessage(message) {
        switch (message.type) {
            case 'PRE-PREPARE':
                this.prepare(message);
                break;
            case 'PREPARE':
                this.commit(message);
                break;
            case 'COMMIT':
                this.processCommit(message);
                break;
        }
    }

    addBlock(block) {
        block.previousHash = this.getLatestBlock().hash;
        block.mineBlock(4);
        this.blockchain.push(block);
    }

    getLatestBlock() {
        return this.blockchain[this.blockchain.length - 1];
    }

    isValidNewBlock(newBlock, previousBlock) {
        return previousBlock.index + 1 === newBlock.index &&
               previousBlock.hash === newBlock.previousHash &&
               newBlock.calculateHash() === newBlock.hash;
    }

    isChainValid() {
        for (let i = 1; i < this.blockchain.length; i++) {
            const currentBlock = this.blockchain[i];
            const previousBlock = this.blockchain[i - 1];
            if (currentBlock.hash !== currentBlock.calculateHash() ||
                currentBlock.previousHash !== previousBlock.hash) {
                return false;
            }
        }
        return true;
    }
}

// Example usage:
const totalNodes = 4;
const faultyNodes = 1;

const nodes = Array.from({length: totalNodes}, (_, i) => new Node(i, totalNodes, faultyNodes));

// Connect peers
nodes.forEach(node => nodes.forEach(peer => {
    if (node.id !== peer.id) node.addPeer(peer);
}));

// Simulate a node failure
nodes[0].simulateFailure();

// Primary node proposes a new block
const newBlock = new Block(1, Date.now(), { amount: 100 });
nodes[1].prePrepare(newBlock);

// After some time, check chain validity
setTimeout(() => {
    nodes.forEach((node, i) => {
        console.log(`Node ${i} chain valid: ${node.isChainValid()}`);
    });
}, 5000);
=======
const crypto = require('crypto');

class Block {
    constructor(index, timestamp, data, previousHash = '') {
        this.index = index;
        this.timestamp = timestamp;
        this.data = data;
        this.previousHash = previousHash;
        this.hash = this.calculateHash();
        this.nonce = 0;
    }

    calculateHash() {
        return crypto.createHash('sha256')
            .update(this.index + this.previousHash + this.timestamp + JSON.stringify(this.data) + this.nonce)
            .digest('hex');
    }

    mineBlock(difficulty) {
        while (this.hash.substring(0, difficulty) !== Array(difficulty + 1).join("0")) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
    }
}

class Node {
    constructor(id, totalNodes, faultyNodes) {
        this.id = id;
        this.blockchain = [this.createGenesisBlock()];
        this.peers = [];
        this.totalNodes = totalNodes;
        this.faultyNodes = faultyNodes;
        this.f = faultyNodes;
        this.sequenceNumber = 0;
        this.state = 'NORMAL';
        this.prePrepareMessages = {};
        this.prepareMessages = {};
        this.commitMessages = {};
    }

    createGenesisBlock() {
        return new Block(0, Date.now(), "Genesis Block", "0");
    }

    addPeer(node) {
        this.peers.push(node);
    }

    simulateFailure() {
        this.state = 'FAULTY';
    }

    prePrepare(block) {
        if (this.state === 'FAULTY') return;
        this.sequenceNumber++;
        const message = {
            type: 'PRE-PREPARE',
            view: 0,
            sequenceNumber: this.sequenceNumber,
            block: block,
            nodeId: this.id
        };
        this.multicast(message);
    }

    prepare(message) {
        if (this.state === 'FAULTY') return;
        const { sequenceNumber, block } = message;

        if (!this.prePrepareMessages[sequenceNumber]) {
            this.prePrepareMessages[sequenceNumber] = [];
        }

        if (!this.prePrepareMessages[sequenceNumber].some(msg => msg.nodeId === message.nodeId)) {
            this.prePrepareMessages[sequenceNumber].push(message);
        }

        const prepareMessage = {
            type: 'PREPARE',
            view: 0,
            sequenceNumber: sequenceNumber,
            blockHash: block.hash,
            nodeId: this.id
        };

        this.multicast(prepareMessage);
    }

    commit(message) {
        if (this.state === 'FAULTY') return;
        const { sequenceNumber, blockHash } = message;

        if (!this.prepareMessages[sequenceNumber]) {
            this.prepareMessages[sequenceNumber] = [];
        }

        if (!this.prepareMessages[sequenceNumber].some(msg => msg.nodeId === message.nodeId)) {
            this.prepareMessages[sequenceNumber].push(message);
        }

        const commitMessage = {
            type: 'COMMIT',
            view: 0,
            sequenceNumber: sequenceNumber,
            blockHash: blockHash,
            nodeId: this.id
        };
        this.multicast(commitMessage);
    }

    processCommit(message) {
        if (this.state === 'FAULTY') return;
        const { sequenceNumber, blockHash } = message;

        if (!this.commitMessages[sequenceNumber]) {
            this.commitMessages[sequenceNumber] = [];
        }

        if (!this.commitMessages[sequenceNumber].some(msg => msg.nodeId === message.nodeId)) {
            this.commitMessages[sequenceNumber].push(message);
        }

        const commitCount = this.commitMessages[sequenceNumber].filter(m => m.blockHash === blockHash).length;
        if (commitCount >= 2 * this.f + 1) {
            const block = this.prePrepareMessages[sequenceNumber][0].block;
            if (this.isValidNewBlock(block, this.getLatestBlock())) {
                this.blockchain.push(block);
                this.prePrepareMessages[sequenceNumber] = [];
                this.prepareMessages[sequenceNumber] = [];
                this.commitMessages[sequenceNumber] = [];
            }
        }
    }

    multicast(message) {
        this.peers.forEach(peer => {
            if (peer.id !== this.id) peer.receiveMessage(message);
        });
    }

    receiveMessage(message) {
        switch (message.type) {
            case 'PRE-PREPARE':
                this.prepare(message);
                break;
            case 'PREPARE':
                this.commit(message);
                break;
            case 'COMMIT':
                this.processCommit(message);
                break;
        }
    }

    addBlock(block) {
        block.previousHash = this.getLatestBlock().hash;
        block.mineBlock(4);
        this.blockchain.push(block);
    }

    getLatestBlock() {
        return this.blockchain[this.blockchain.length - 1];
    }

    isValidNewBlock(newBlock, previousBlock) {
        return previousBlock.index + 1 === newBlock.index &&
               previousBlock.hash === newBlock.previousHash &&
               newBlock.calculateHash() === newBlock.hash;
    }

    isChainValid() {
        for (let i = 1; i < this.blockchain.length; i++) {
            const currentBlock = this.blockchain[i];
            const previousBlock = this.blockchain[i - 1];
            if (currentBlock.hash !== currentBlock.calculateHash() ||
                currentBlock.previousHash !== previousBlock.hash) {
                return false;
            }
        }
        return true;
    }
}

// Example usage:
const totalNodes = 4;
const faultyNodes = 1;

const nodes = Array.from({length: totalNodes}, (_, i) => new Node(i, totalNodes, faultyNodes));

// Connect peers
nodes.forEach(node => nodes.forEach(peer => {
    if (node.id !== peer.id) node.addPeer(peer);
}));

// Simulate a node failure
nodes[0].simulateFailure();

// Primary node proposes a new block
const newBlock = new Block(1, Date.now(), { amount: 100 });
nodes[1].prePrepare(newBlock);

// After some time, check chain validity
setTimeout(() => {
    nodes.forEach((node, i) => {
        console.log(`Node ${i} chain valid: ${node.isChainValid()}`);
    });
}, 5000);
>>>>>>> a733842ed834181faf75303a2dbf2d066e90afd9
