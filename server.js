
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const oracledb = require("oracledb");
const crypto = require("crypto");
const { promisify } = require("util");

const app = express();
const PORT = process.env.PORT || 5000;

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const scryptAsync = promisify(crypto.scrypt);

app.use(cors());
app.use(express.json({ limit: "20kb" }));

// Oracle connection
async function getConnection() {
    return await oracledb.getConnection({
        user: process.env.ORACLE_USER,
        password: process.env.ORACLE_PASSWORD,
        connectString: process.env.ORACLE_CONNECT_STRING
    });
}

// Generate 8-character Customer Number: AAAA1001
function generateCustomerNumber() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    let prefix = "";

    for (let i = 0; i < 4; i++) {
        prefix += letters[crypto.randomInt(letters.length)];
    }

    const suffix = crypto.randomInt(1000, 10000);

    return prefix + suffix;
}

// Generate PIN hash and random salt
async function hashPin(pin, salt) {
    const hash = await scryptAsync(pin, salt, 64);
    return hash.toString("hex");
}

// Validate date in dd/MM/yyyy format
function parseDate(dateString) {
    if (!dateString) return null;

    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateString);

    if (!match) {
        throw new Error("Date of birth must be dd/MM/yyyy");
    }

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);

    const date = new Date(year, month - 1, day);

    if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day ||
        date > new Date()
    ) {
        throw new Error("Invalid date of birth");
    }

    return date;
}

// Basic server test
app.get("/", (req, res) => {
    res.send("Sonali e-Wallet Backend Running");
});

// Oracle connection test
app.get("/api/db-test", async (req, res) => {
    let connection;

    try {
        connection = await getConnection();

        const result = await connection.execute(
            `SELECT USER AS DB_USER,
                    SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS SERVICE_NAME
             FROM DUAL`
        );

        res.json({
            success: true,
            message: "Oracle Database Connected Successfully!",
            database: result.rows[0]
        });

    } catch (error) {
        console.error("Database test failed:", error.message);

        res.status(500).json({
            success: false,
            message: "Database connection failed"
        });

    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (error) {
                console.error("Connection close failed:", error.message);
            }
        }
    }
});

// REGISTRATION API
app.post("/api/register", async (req, res) => {
    let connection;
    let transactionStarted = false;

    try {
        const {
            fullName,
            mobile,
            nid,
            dob,
            pin
        } = req.body;

        // Input validation
        if (!fullName || !mobile || !pin) {
            return res.status(400).json({
                success: false,
                message: "Name, mobile number and PIN are required"
            });
        }

        const cleanName = String(fullName).trim();
        const cleanMobile = String(mobile).trim();
        const cleanNid = nid ? String(nid).trim() : null;
        const cleanPin = String(pin).trim();

        if (cleanName.length > 150) {
            return res.status(400).json({
                success: false,
                message: "Name is too long"
            });
        }

        if (!/^01[3-9]\d{8}$/.test(cleanMobile)) {
            return res.status(400).json({
                success: false,
                message: "Invalid Bangladesh mobile number"
            });
        }

        if (cleanNid && !/^\d{10}$|^\d{13}$|^\d{17}$/.test(cleanNid)) {
            return res.status(400).json({
                success: false,
                message: "Invalid NID number"
            });
        }

        if (!/^\d{6}$/.test(cleanPin)) {
            return res.status(400).json({
                success: false,
                message: "PIN must contain exactly 6 digits"
            });
        }

        const birthDate = parseDate(dob);

        connection = await getConnection();

        // Check duplicate mobile number
        const mobileCheck = await connection.execute(
            `SELECT COUNT(*) AS TOTAL
             FROM CUSTOMER_CONTACT
             WHERE CONTACT_TYPE = 'MOBILE'
               AND CONTACT_VALUE = :mobile`,
            { mobile: cleanMobile }
        );

        if (mobileCheck.rows[0].TOTAL > 0) {
            return res.status(409).json({
                success: false,
                message: "This mobile number is already registered"
            });
        }

        // Check duplicate NID
        if (cleanNid) {
            const nidCheck = await connection.execute(
                `SELECT COUNT(*) AS TOTAL
                 FROM CUSTOMER
                 WHERE NID_NUMBER = :nid`,
                { nid: cleanNid }
            );

            if (nidCheck.rows[0].TOTAL > 0) {
                return res.status(409).json({
                    success: false,
                    message: "This NID is already registered"
                });
            }
        }

        // Generate unique customer number
        let customerNumber;
        let uniqueNumberFound = false;

        for (let i = 0; i < 20; i++) {
            customerNumber = generateCustomerNumber();

            const check = await connection.execute(
                `SELECT COUNT(*) AS TOTAL
                 FROM CUSTOMER
                 WHERE CUSTOMER_NUMBER = :customerNumber`,
                { customerNumber }
            );

            if (check.rows[0].TOTAL === 0) {
                uniqueNumberFound = true;
                break;
            }
        }

        if (!uniqueNumberFound) {
            return res.status(500).json({
                success: false,
                message: "Unable to generate customer number"
            });
        }

        // Generate unique salt and PIN hash
        const salt = crypto.randomBytes(16).toString("hex");
        const passwordHash = await hashPin(cleanPin, salt);

        // Start database transaction
        transactionStarted = true;

        // 1. Insert CUSTOMER
        const customerResult = await connection.execute(
            `INSERT INTO CUSTOMER
                (CUSTOMER_NUMBER, FULL_NAME, NID_NUMBER, DATE_OF_BIRTH)
             VALUES
                (:customerNumber, :fullName, :nid, :dob)
             RETURNING CUSTOMER_ID INTO :customerId`,
            {
                customerNumber,
                fullName: cleanName,
                nid: cleanNid,
                dob: birthDate,
                customerId: {
                    dir: oracledb.BIND_OUT,
                    type: oracledb.NUMBER
                }
            },
            { autoCommit: false }
        );

        const customerId = customerResult.outBinds.customerId[0];

        // 2. Insert CUSTOMER_CONTACT
        await connection.execute(
            `INSERT INTO CUSTOMER_CONTACT
                (CUSTOMER_ID, CONTACT_TYPE, CONTACT_VALUE)
             VALUES
                (:customerId, 'MOBILE', :mobile)`,
            {
                customerId,
                mobile: cleanMobile
            },
            { autoCommit: false }
        );

        // 3. Insert E_WALLET_USER
        const userResult = await connection.execute(
            `INSERT INTO E_WALLET_USER
                (CUSTOMER_ID, USER_NAME)
             VALUES
                (:customerId, :userName)
             RETURNING USER_ID INTO :userId`,
            {
                customerId,
                userName: cleanMobile,
                userId: {
                    dir: oracledb.BIND_OUT,
                    type: oracledb.NUMBER
                }
            },
            { autoCommit: false }
        );

        const userId = userResult.outBinds.userId[0];

        // 4. Insert USER_CREDENTIAL
        await connection.execute(
            `INSERT INTO USER_CREDENTIAL
                (USER_ID, CREDENTIAL_TYPE,
                 PASSWORD_HASH, PASSWORD_SALT)
             VALUES
                (:userId, 'PIN', :passwordHash, :salt)`,
            {
                userId,
                passwordHash,
                salt
            },
            { autoCommit: false }
        );

        // All four inserts succeeded
        await connection.commit();
        transactionStarted = false;

        res.status(201).json({
            success: true,
            message: "Registration Successful!",
            customerId,
            userId,
            customerNumber
        });

    } catch (error) {
        if (connection && transactionStarted) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Rollback failed:", rollbackError.message);
            }
        }

        console.error("Registration failed:", error.message);

        res.status(500).json({
            success: false,
            message: "Registration failed. Please check your information."
        });

    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (error) {
                console.error("Connection close failed:", error.message);
            }
        }
    }
});

// LOGIN API
app.post("/api/login", async (req, res) => {
    let connection;

    try {
        const { mobile, pin } = req.body;

        if (!mobile || !pin) {
            return res.status(400).json({
                success: false,
                message: "Mobile number and PIN are required"
            });
        }

        const cleanMobile = String(mobile).trim();
        const cleanPin = String(pin).trim();

        if (
            !/^01[3-9]\d{8}$/.test(cleanMobile) ||
            !/^\d{6}$/.test(cleanPin)
        ) {
            return res.status(401).json({
                success: false,
                message: "Invalid mobile number or PIN"
            });
        }

        connection = await getConnection();

        const result = await connection.execute(
            `SELECT
                U.USER_ID,
                U.CUSTOMER_ID,
                U.STATUS AS USER_STATUS,
                C.FULL_NAME,
                UC.PASSWORD_HASH,
                UC.PASSWORD_SALT,
                UC.STATUS AS CREDENTIAL_STATUS
             FROM E_WALLET_USER U
             JOIN CUSTOMER C
               ON C.CUSTOMER_ID = U.CUSTOMER_ID
             JOIN CUSTOMER_CONTACT CC
               ON CC.CUSTOMER_ID = C.CUSTOMER_ID
             JOIN USER_CREDENTIAL UC
               ON UC.USER_ID = U.USER_ID
             WHERE U.USER_NAME = :mobile
               AND CC.CONTACT_TYPE = 'MOBILE'
               AND CC.CONTACT_VALUE = :mobile
               AND UC.CREDENTIAL_TYPE = 'PIN'
               AND U.STATUS = 'ACTIVE'
               AND C.STATUS = 'ACTIVE'
               AND UC.STATUS = 'ACTIVE'
             FETCH FIRST 1 ROWS ONLY`,
            { mobile: cleanMobile },
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Invalid mobile number or PIN"
            });
        }

        const user = result.rows[0];

        const enteredHash = await hashPin(
            cleanPin,
            user.PASSWORD_SALT
        );

        const savedHash = Buffer.from(
            user.PASSWORD_HASH,
            "hex"
        );

        const newHash = Buffer.from(enteredHash, "hex");

        const pinMatches =
            savedHash.length === newHash.length &&
            crypto.timingSafeEqual(savedHash, newHash);

        if (!pinMatches) {
            return res.status(401).json({
                success: false,
                message: "Invalid mobile number or PIN"
            });
        }

       res.json({
    success: true,
    message: "Login Successful!",
    userId: user.USER_ID,
    customerId: user.CUSTOMER_ID,
    fullName: user.FULL_NAME
});

    } catch (error) {
        console.error("Login failed:", error.message);

        res.status(500).json({
            success: false,
            message: "Login failed. Please try again."
        });

    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (error) {
                console.error("Connection close failed:", error.message);
            }
        }
    }
});

// DASHBOARD BALANCE API
app.get("/api/dashboard/:customerId", async (req, res) => {
    let connection;

    try {
        const customerId = Number(req.params.customerId);

        if (!Number.isSafeInteger(customerId) || customerId <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid customer ID"
            });
        }

        connection = await getConnection();

        const result = await connection.execute(
            `SELECT
                C.CUSTOMER_ID,

                NVL((
                    SELECT SUM(A.BALANCE)
                    FROM ACCOUNT_HOLDER AH
                    JOIN ACCOUNT A
                      ON A.ACCOUNT_ID = AH.ACCOUNT_ID
                    WHERE AH.CUSTOMER_ID = C.CUSTOMER_ID
                ), 0) AS BANK_BALANCE,

                NVL((
                    SELECT SUM(
                        CASE
                            WHEN L.ENTRY_TYPE = 'CREDIT'
                                THEN L.ENTRY_AMOUNT
                            WHEN L.ENTRY_TYPE = 'DEBIT'
                                THEN -L.ENTRY_AMOUNT
                        END
                    )
                    FROM MFS_ACCOUNT M
                    JOIN MFS_WALLET_LEDGER L
                      ON L.MFS_ACCOUNT_ID = M.MFS_ACCOUNT_ID
                    WHERE M.CUSTOMER_ID = C.CUSTOMER_ID
                      AND M.STATUS = 'ACTIVE'
                ), 0) AS WALLET_BALANCE

             FROM CUSTOMER C
             WHERE C.CUSTOMER_ID = :customerId
               AND C.STATUS = 'ACTIVE'`,
            { customerId }
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Customer not found"
            });
        }

        const account = result.rows[0];

        res.json({
            success: true,
            message: "Dashboard Balance Retrieved Successfully",
            customerId: account.CUSTOMER_ID,
            bankBalance: account.BANK_BALANCE,
            walletBalance: account.WALLET_BALANCE
        });

    } catch (error) {
        console.error("Dashboard API failed:", error.message);

        res.status(500).json({
            success: false,
            message: "Unable to retrieve dashboard balance"
        });

    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (error) {
                console.error("Connection close failed:", error.message);
            }
        }
    }
});

// Start server
app.listen(PORT, () => {
    console.log(
        `Sonali e-Wallet Backend running on port ${PORT}`
    );
});
