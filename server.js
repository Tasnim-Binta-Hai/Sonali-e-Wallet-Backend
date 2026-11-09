
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const oracledb = require("oracledb");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// Basic server test
app.get("/", (req, res) => {
    res.send("Sonali e-Wallet Backend Running");
});

// Oracle Database connection test
app.get("/api/db-test", async (req, res) => {
    let connection;

    try {
        connection = await oracledb.getConnection({
            user: process.env.ORACLE_USER,
            password: process.env.ORACLE_PASSWORD,
            connectString: process.env.ORACLE_CONNECT_STRING
        });

        const result = await connection.execute(
            `SELECT
                USER AS DB_USER,
                SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS SERVICE_NAME
             FROM DUAL`
        );

        res.json({
            success: true,
            message: "Oracle Database Connected Successfully!",
            database: result.rows[0]
        });

    } catch (error) {
        console.error("Oracle Connection Error:", error.message);

        res.status(500).json({
            success: false,
            message: "Oracle Database Connection Failed",
            error: error.message
        });

    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (error) {
                console.error("Connection Close Error:", error.message);
            }
        }
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Sonali e-Wallet Backend running on port ${PORT}`);
});
