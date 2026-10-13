// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VeriFin InvoiceRegistry
/// @notice Cross-lender double-financing registry + buyer confirmations + audit anchoring.
/// Only keyed hashes (HMAC fingerprints) and Merkle roots are stored. No invoice data, no PII.
contract InvoiceRegistry {
    enum Status { None, Financed, Released }

    struct Record {
        address lender;
        uint64 registeredAt;
        Status status;
        bytes32 commitment; // Merkle root of salted invoice fields (selective disclosure)
    }

    struct Confirmation {
        address buyer;
        uint64 confirmedAt;
    }

    struct Anchor {
        bytes32 root;
        uint64 fromEvent;
        uint64 toEvent;
        uint64 timestamp;
    }

    mapping(bytes32 => Record) public records;
    mapping(bytes32 => Confirmation) public confirmations;
    Anchor[] public anchors;

    event InvoiceFinanced(bytes32 indexed fingerprint, address indexed lender, bytes32 commitment);
    event InvoiceReleased(bytes32 indexed fingerprint, address indexed lender);
    event InvoiceConfirmed(bytes32 indexed fingerprint, address indexed buyer);
    event RootAnchored(uint256 indexed index, bytes32 root, uint64 fromEvent, uint64 toEvent);

    function register(bytes32 fingerprint, bytes32 commitment) external {
        require(records[fingerprint].status != Status.Financed, "DUPLICATE_FINANCING");
        records[fingerprint] = Record(msg.sender, uint64(block.timestamp), Status.Financed, commitment);
        emit InvoiceFinanced(fingerprint, msg.sender, commitment);
    }

    function release(bytes32 fingerprint) external {
        Record storage r = records[fingerprint];
        require(r.status == Status.Financed && r.lender == msg.sender, "NOT_OWNER");
        r.status = Status.Released;
        emit InvoiceReleased(fingerprint, msg.sender);
    }

    function confirm(bytes32 fingerprint) external {
        confirmations[fingerprint] = Confirmation(msg.sender, uint64(block.timestamp));
        emit InvoiceConfirmed(fingerprint, msg.sender);
    }

    function anchor(bytes32 root, uint64 fromEvent, uint64 toEvent) external returns (uint256) {
        anchors.push(Anchor(root, fromEvent, toEvent, uint64(block.timestamp)));
        emit RootAnchored(anchors.length - 1, root, fromEvent, toEvent);
        return anchors.length - 1;
    }

    function anchorCount() external view returns (uint256) {
        return anchors.length;
    }
}
