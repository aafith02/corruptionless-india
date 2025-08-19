import crypto from 'crypto'; 
const { generateKeyPairSync, createSign, createVerify } = crypto;

class Block {
    constructor(index, timestamp, data, previousHash = '') {
        this.index = index;
        this.timestamp = timestamp;
        this.data = data;
        this.previousHash = previousHash;
        this.hash = this.calculateHash();
        this.signatures = [];
    }

    calculateHash() {
        return crypto.createHash('sha256')
            .update(this.index + this.previousHash + this.timestamp + JSON.stringify(this.data))
            .digest('hex');
    }

    addSignature(nodeId, signature) {
        this.signatures.push({ nodeId, signature });
    }
}

class SecureNode {
    constructor(id, totalNodes, faultyNodes) {
        this.id = id;
        const { publicKey, privateKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        this.publicKey = publicKey;
        this.privateKey = privateKey;
        this.peerPublicKeys = {};
        this.blockchain = [this.createGenesisBlock()];
        this.peers = [];
        this.totalNodes = totalNodes;
        this.f = Math.floor((totalNodes - 1) / 3);
        this.sequenceNumber = 0;
        this.view = 0;
        this.primaryId = 0;
        this.state = 'NORMAL';
        this.prePrepareMessages = {};
        this.prepareMessages = {};
        this.commitMessages = {};
    }

    createGenesisBlock() {
        return new Block(0, Date.now(), "Genesis Block", "0");
    }

    registerPeerPublicKeys(publicKeys) {
        this.peerPublicKeys = publicKeys;
    }

    addPeer(node) {
        this.peers.push(node);
    }

    signMessage(message) {
        const sign = createSign('SHA256');
        const msgStr = JSON.stringify(message, (k,v) => k==='signature'?undefined:v);
        sign.update(msgStr);
        sign.end();
        return sign.sign(this.privateKey, 'base64');
    }

    verifyMessage(message, signature, nodeId) {
        try {
            const verify = createVerify('SHA256');
            const msgStr = JSON.stringify(message, (k,v) => k==='signature'?undefined:v);
            verify.update(msgStr);
            verify.end();
            return verify.verify(this.peerPublicKeys[nodeId], signature, 'base64');
        } catch {
            return false;
        }
    }

    simulateFailure() {
        this.state = 'FAULTY';
        console.log(`Node ${this.id} is now FAULTY`);
    }

    isPrimary() {
        return this.id === this.primaryId;
    }

    secureMulticast(message) {
        if (this.state === 'FAULTY') return;
        const sig = this.signMessage(message);
        const signedMsg = {...message, signature: sig, timestamp: Date.now()};
        this.peers.forEach(peer => {
            if (peer.id !== this.id) {
                setTimeout(() => peer.receiveMessage(signedMsg), Math.random() * 100);
            }
        });
    }

    prePrepare(block) {
        if (this.state === 'FAULTY' || !this.isPrimary()) return;
        this.sequenceNumber++;
        const msg = {
            type: 'PRE-PREPARE',
            view: this.view,
            sequenceNumber: this.sequenceNumber,
            block: block,
            blockHash: block.hash,
            nodeId: this.id
        };
        this.secureMulticast(msg);
    }

    prepare(message) {
        if (this.state === 'FAULTY') return;
        if (!this.verifyMessage(message, message.signature, message.nodeId)) return;
        const seq = message.sequenceNumber;
        if (!this.prePrepareMessages[seq]) this.prePrepareMessages[seq] = [];
        if (!this.prePrepareMessages[seq].some(m => m.nodeId===message.nodeId && m.signature===message.signature))
            this.prePrepareMessages[seq].push(message);

        const prepareMsg = {
            type: 'PREPARE',
            view: this.view,
            sequenceNumber: seq,
            blockHash: message.blockHash,
            nodeId: this.id
        };
        this.secureMulticast(prepareMsg);
    }

    commit(message) {
        if (this.state === 'FAULTY') return;
        if (!this.verifyMessage(message, message.signature, message.nodeId)) return;

        const seq = message.sequenceNumber;
        if (!this.prepareMessages[seq]) this.prepareMessages[seq] = [];
        if (!this.prepareMessages[seq].some(m=>m.nodeId===message.nodeId && m.signature===message.signature))
            this.prepareMessages[seq].push(message);

        const prepareCount = this.prepareMessages[seq].length;
        if (prepareCount >= 2*this.f) {
            const commitMsg = {
                type: 'COMMIT',
                view: this.view,
                sequenceNumber: seq,
                blockHash: message.blockHash,
                nodeId: this.id
            };
            this.secureMulticast(commitMsg);
        }
    }

    processCommit(message) {
        if (this.state === 'FAULTY') return;
        if (!this.verifyMessage(message, message.signature, message.nodeId)) return;

        const seq = message.sequenceNumber;
        if (!this.commitMessages[seq]) this.commitMessages[seq] = [];
        if (!this.commitMessages[seq].some(m=>m.nodeId===message.nodeId && m.signature===message.signature))
            this.commitMessages[seq].push(message);

        const commitCount = this.commitMessages[seq].length;
        if (commitCount >= 2*this.f + 1) {
            const block = this.prePrepareMessages[seq][0]?.block;
            if (block && this.isValidNewBlock(block, this.getLatestBlock())) {
                this.commitMessages[seq].forEach(m => block.addSignature(m.nodeId, m.signature));
                this.blockchain.push(block);
                delete this.prePrepareMessages[seq];
                delete this.prepareMessages[seq];
                delete this.commitMessages[seq];
                console.log(`Node ${this.id} committed block ${seq}`);
            }
        }
    }

    receiveMessage(message) {
        if (this.state === 'FAULTY') return;
        if (!message || !message.type || !message.signature) return;
        switch(message.type){
            case 'PRE-PREPARE': this.prepare(message); break;
            case 'PREPARE': this.commit(message); break;
            case 'COMMIT': this.processCommit(message); break;
        }
    }

    getLatestBlock() {
        return this.blockchain[this.blockchain.length-1];
    }

    isValidNewBlock(newBlock, prevBlock) {
        return prevBlock.index+1 === newBlock.index &&
               prevBlock.hash === newBlock.previousHash &&
               newBlock.calculateHash() === newBlock.hash &&
               newBlock.signatures.length >= 2*this.f + 1;
    }

    isChainValid() {
        for(let i=1;i<this.blockchain.length;i++){
            const curr = this.blockchain[i];
            const prev = this.blockchain[i-1];
            if(curr.hash!==curr.calculateHash() || curr.previousHash!==prev.hash || curr.signatures.length<2*this.f+1)
                return false;
        }
        return true;
    }
}

// Example usage
async function runPBFT() {
    const totalNodes = 4;
    const faultyNodes = 1;

    // Generate key pairs
    const nodeKeys = [];
    for(let i=0;i<totalNodes;i++){
        const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength:2048, publicKeyEncoding:{type:'spki', format:'pem'}, privateKeyEncoding:{type:'pkcs8', format:'pem'}});
        nodeKeys.push({publicKey, privateKey});
    }

    // Public key map
    const publicKeys = {};
    nodeKeys.forEach((k,i)=>publicKeys[i]=k.publicKey);

    // Create nodes
    const nodes = Array.from({length: totalNodes}, (_,i)=>{
        const node = new SecureNode(i,totalNodes,faultyNodes);
        node.privateKey=nodeKeys[i].privateKey;
        node.publicKey=nodeKeys[i].publicKey;
        node.registerPeerPublicKeys(publicKeys);
        return node;
    });

    // Connect peers
    nodes.forEach(n=>nodes.forEach(p=>{if(n.id!==p.id) n.addPeer(p);}));

    console.log("Secure PBFT network initialized");

    // Simulate faulty primary
    nodes[0].simulateFailure();

    // Primary proposes block (will fail)
    const block1 = new Block(1, Date.now(), {amount:100});
    nodes[0].prePrepare(block1);

    // Valid proposal from node 1 (ignored because not primary)
    const block2 = new Block(1, Date.now(), {amount:50});
    setTimeout(()=>nodes[1].prePrepare(block2), 2000);

    // Check chain validity after 5 seconds
    setTimeout(()=>{
        nodes.forEach((n,i)=>{
            console.log(`Node ${i} chain valid: ${n.isChainValid()}, blocks: ${n.blockchain.length}`);
        });
    },5000);
}

runPBFT();
