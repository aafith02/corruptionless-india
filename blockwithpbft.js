const crypto = require('crypto');

class Block {
    constructor(index, timestamp, data, previousHash = '') {
        this.index = index;
        this.timestamp = timestamp;
        this.data = data;
        this.previousHash = previousHash;
        this.hash = this.calculateHash();
        this.nonce = 0;
    }const crypto = require('crypto');
const { generateKeyPairSync, createSign, createVerify } = crypto;

class Block {
    constructor(index, timestamp, data, previousHash = '') {
        this.index = index;
        this.timestamp = timestamp;
        this.data = data;
        this.previousHash = previousHash;
        this.hash = this.calculateHash();
        this.nonce = 0;
        this.signatures = []; // Store commit signatures for verification
    }

    calculateHash() {
        return crypto.createHash('sha256')
            .update(this.index + this.previousHash + this.timestamp + 
                   JSON.stringify(this.data) + this.nonce + this.signatures.join(''))
            .digest('hex');
    }

    mineBlock(difficulty) {
        while (this.hash.substring(0, difficulty) !== Array(difficulty + 1).join("0")) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
    }

    addSignature(nodeId, signature) {
        this.signatures.push({ nodeId, signature });
    }
}

class SecureNode {
    constructor(id, totalNodes, faultyNodes) {
        this.id = id;
        
        // Generate cryptographic key pair for this node
        const { privateKey, publicKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        
        this.privateKey = privateKey;
        this.publicKey = publicKey;
        this.peerPublicKeys = {}; // Will store other nodes' public keys
        this.blockchain = [this.createGenesisBlock()];
        this.peers = [];
        this.totalNodes = totalNodes;
        this.faultyNodes = faultyNodes;
        this.f = Math.floor((totalNodes - 1) / 3); // Calculate maximum faulty nodes
        this.sequenceNumber = 0;
        this.view = 0;
        this.primaryId = 0; // Primary node ID for current view
        this.state = 'NORMAL';
        this.prePrepareMessages = {};
        this.prepareMessages = {};
        this.commitMessages = {};
        this.checkpointInterval = 10;
        this.lastStableCheckpoint = 0;
    }

    createGenesisBlock() {
        const genesis = new Block(0, Date.now(), "Genesis Block", "0");
        // Genesis block doesn't need mining as it's trusted
        return genesis;
    }

    registerPeerPublicKeys(publicKeys) {
        this.peerPublicKeys = publicKeys;
    }

    addPeer(node) {
        this.peers.push(node);
    }

    // Cryptographic message signing
    signMessage(message) {
        const sign = createSign('SHA256');
        const messageString = JSON.stringify(message, (key, value) => {
            return key === 'signature' ? undefined : value;
        });
        sign.update(messageString);
        sign.end();
        return sign.sign(this.privateKey, 'base64');
    }

    // Message verification
    verifyMessage(message, signature, nodeId) {
        try {
            const verify = createVerify('SHA256');
            const messageString = JSON.stringify(message, (key, value) => {
                return key === 'signature' ? undefined : value;
            });
            verify.update(messageString);
            verify.end();
            return verify.verify(this.peerPublicKeys[nodeId], signature, 'base64');
        } catch (error) {
            return false;
        }
    }

    // Create message digest for efficiency and security
    createMessageDigest(message) {
        return crypto.createHash('sha256')
            .update(JSON.stringify(message))
            .digest('hex');
    }

    simulateFailure() {
        this.state = 'FAULTY';
        console.log(`Node ${this.id} is now FAULTY`);
    }

    isPrimary() {
        return this.id === this.primaryId;
    }

    // Secure multicast with signatures
    secureMulticast(message) {
        if (this.state === 'FAULTY') return;

        // Sign the message (excluding any existing signature field)
        const messageToSign = {...message};
        delete messageToSign.signature;
        
        const signature = this.signMessage(messageToSign);
        const signedMessage = {
            ...messageToSign,
            signature: signature,
            timestamp: Date.now()
        };

        this.peers.forEach(peer => {
            if (peer.id !== this.id) {
                setTimeout(() => peer.receiveMessage(signedMessage), 
                          Math.random() * 100); // Simulate network delay
            }
        });
    }

    prePrepare(block) {
        if (this.state === 'FAULTY' || !this.isPrimary()) return;
        
        this.sequenceNumber++;
        const message = {
            type: 'PRE-PREPARE',
            view: this.view,
            sequenceNumber: this.sequenceNumber,
            block: block,
            blockHash: block.hash,
            nodeId: this.id,
            messageDigest: this.createMessageDigest(block)
        };
        
        this.secureMulticast(message);
    }

    prepare(message) {
        if (this.state === 'FAULTY') return;

        // Verify the message signature and integrity
        if (!this.verifyMessage(message, message.signature, message.nodeId)) {
            console.log(`Node ${this.id}: Invalid signature from node ${message.nodeId}`);
            return;
        }

        const { sequenceNumber, blockHash, messageDigest } = message;

        // Verify we have the correct pre-prepare message
        if (!this.prePrepareMessages[sequenceNumber]) {
            this.prePrepareMessages[sequenceNumber] = [];
        }

        // Check for duplicate messages
        if (!this.prePrepareMessages[sequenceNumber].some(msg => 
            msg.nodeId === message.nodeId && msg.signature === message.signature)) {
            
            this.prePrepareMessages[sequenceNumber].push(message);
        }

        const prepareMessage = {
            type: 'PREPARE',
            view: this.view,
            sequenceNumber: sequenceNumber,
            blockHash: blockHash,
            messageDigest: messageDigest,
            nodeId: this.id
        };

        this.secureMulticast(prepareMessage);
    }

    commit(message) {
        if (this.state === 'FAULTY') return;

        // Verify the message signature
        if (!this.verifyMessage(message, message.signature, message.nodeId)) {
            return;
        }

        const { sequenceNumber, blockHash, messageDigest } = message;

        if (!this.prepareMessages[sequenceNumber]) {
            this.prepareMessages[sequenceNumber] = [];
        }

        // Check if we have enough prepare messages (2f)
        const prepareCount = this.prepareMessages[sequenceNumber].filter(m => 
            m.blockHash === blockHash && m.messageDigest === messageDigest
        ).length;

        if (prepareCount >= 2 * this.f) {
            if (!this.prepareMessages[sequenceNumber].some(msg => 
                msg.nodeId === message.nodeId && msg.signature === message.signature)) {
                
                this.prepareMessages[sequenceNumber].push(message);
            }

            const commitMessage = {
                type: 'COMMIT',
                view: this.view,
                sequenceNumber: sequenceNumber,
                blockHash: blockHash,
                messageDigest: messageDigest,
                nodeId: this.id
            };
            this.secureMulticast(commitMessage);
        }
    }

    processCommit(message) {
        if (this.state === 'FAULTY') return;

        // Verify the message signature
        if (!this.verifyMessage(message, message.signature, message.nodeId)) {
            return;
        }

        const { sequenceNumber, blockHash, messageDigest } = message;

        if (!this.commitMessages[sequenceNumber]) {
            this.commitMessages[sequenceNumber] = [];
        }

        if (!this.commitMessages[sequenceNumber].some(msg => 
            msg.nodeId === message.nodeId && msg.signature === message.signature)) {
            
            this.commitMessages[sequenceNumber].push(message);
        }

        // Check if we have enough commit messages (2f + 1)
        const commitCount = this.commitMessages[sequenceNumber].filter(m => 
            m.blockHash === blockHash && m.messageDigest === messageDigest
        ).length;

        if (commitCount >= 2 * this.f + 1) {
            const prePrepareMsg = this.prePrepareMessages[sequenceNumber].find(m => 
                m.blockHash === blockHash);
            
            if (prePrepareMsg && prePrepareMsg.block) {
                const block = prePrepareMsg.block;
                
                // Add all commit signatures to the block for verification
                this.commitMessages[sequenceNumber].forEach(msg => {
                    if (msg.blockHash === blockHash) {
                        block.addSignature(msg.nodeId, msg.signature);
                    }
                });

                if (this.isValidNewBlock(block, this.getLatestBlock())) {
                    this.blockchain.push(block);
                    console.log(`Node ${this.id} committed block ${sequenceNumber}`);
                    
                    // Garbage collection - checkpointing
                    if (sequenceNumber % this.checkpointInterval === 0) {
                        this.lastStableCheckpoint = sequenceNumber;
                        this.cleanupOldMessages(sequenceNumber);
                    }
                }
            }
        }
    }

    cleanupOldMessages(currentSequence) {
        // Remove messages for old sequence numbers
        const sequencesToRemove = Object.keys(this.prePrepareMessages)
            .filter(seq => parseInt(seq) <= this.lastStableCheckpoint);
        
        sequencesToRemove.forEach(seq => {
            delete this.prePrepareMessages[seq];
            delete this.prepareMessages[seq];
            delete this.commitMessages[seq];
        });
    }

    receiveMessage(message) {
        if (this.state === 'FAULTY') return;

        // Basic message validation
        if (!message || !message.type || !message.signature) {
            return;
        }

        // Verify message signature
        if (!this.verifyMessage(message, message.signature, message.nodeId)) {
            console.log(`Node ${this.id}: Received message with invalid signature from node ${message.nodeId}`);
            return;
        }

        // Check message timestamp for replay attacks (within 5 minutes)
        if (Date.now() - message.timestamp > 300000) {
            console.log(`Node ${this.id}: Received stale message`);
            return;
        }

        switch (message.type) {
            case 'PRE-PREPARE':
                // Only accept pre-prepare from primary for current view
                if (message.nodeId === this.primaryId && message.view === this.view) {
                    this.prepare(message);
                }
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
        // Verify block structure and cryptographic integrity
        const validStructure = previousBlock.index + 1 === newBlock.index &&
               previousBlock.hash === newBlock.previousHash;
        
        const validHash = newBlock.calculateHash() === newBlock.hash;
        
        // Verify at least 2f+1 signatures on the block
        const validSignatures = newBlock.signatures.length >= 2 * this.f + 1;

        return validStructure && validHash && validSignatures;
    }

    isChainValid() {
        for (let i = 1; i < this.blockchain.length; i++) {
            const currentBlock = this.blockchain[i];
            const previousBlock = this.blockchain[i - 1];
            
            if (currentBlock.hash !== currentBlock.calculateHash() ||
                currentBlock.previousHash !== previousBlock.hash ||
                currentBlock.signatures.length < 2 * this.f + 1) {
                return false;
            }
        }
        return true;
    }

    // Basic view change protocol (simplified)
    requestViewChange() {
        if (this.state === 'FAULTY') return;
        
        const viewChangeMessage = {
            type: 'VIEW-CHANGE',
            view: this.view + 1,
            nodeId: this.id,
            reason: 'Primary suspected faulty'
        };
        
        this.secureMulticast(viewChangeMessage);
    }
}

// Enhanced example usage with proper security setup
async function runSecurePBFT() {
    const totalNodes = 4;
    const faultyNodes = 1;

    // Generate key pairs for all nodes first
    const nodeKeys = [];
    for (let i = 0; i < totalNodes; i++) {
        const { publicKey, privateKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        nodeKeys.push({ publicKey, privateKey });
    }

    // Create public key mapping
    const publicKeys = {};
    nodeKeys.forEach((keys, index) => {
        publicKeys[index] = keys.publicKey;
    });

    // Create nodes with cryptographic identities
    const nodes = Array.from({length: totalNodes}, (_, i) => {
        const node = new SecureNode(i, totalNodes, faultyNodes);
        node.privateKey = nodeKeys[i].privateKey;
        node.publicKey = nodeKeys[i].publicKey;
        node.registerPeerPublicKeys(publicKeys);
        return node;
    });

    // Connect peers
    nodes.forEach(node => nodes.forEach(peer => {
        if (node.id !== peer.id) node.addPeer(peer);
    }));

    console.log("Secure PBFT Network initialized with 4 nodes");

    // Simulate a node failure
    nodes[0].simulateFailure();

    // Primary node proposes a new block
    const newBlock = new Block(1, Date.now(), { amount: 100, from: "Alice", to: "Bob" });
    console.log("Primary node proposing new block...");
    nodes[0].prePrepare(newBlock); // Node 0 is primary but faulty - should fail

    // After some time, check chain validity
    setTimeout(() => {
        console.log("\n=== Final Blockchain Status ===");
        nodes.forEach((node, i) => {
            console.log(`Node ${i}: Chain valid: ${node.isChainValid()}, Blocks: ${node.blockchain.length}`);
            if (node.isChainValid() && node.blockchain.length > 1) {
                console.log(`  Latest block data:`, node.getLatestBlock().data);
            }
        });
    }, 8000);

    // Let non-faulty nodes also propose blocks after a delay
    setTimeout(() => {
        const validBlock = new Block(1, Date.now(), { amount: 50, from: "Charlie", to: "Diana" });
        console.log("Non-faulty node proposing valid block...");
        nodes[1].prePrepare(validBlock); // Node 1 is not primary, this should be ignored
    }, 2000);
}

// Run the secure implementation
runSecurePBFT().catch(console.error);

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
