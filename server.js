
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors =require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 40;

// --- Global State & Middleware ---
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for large JSON restores

// --- Database Setup ---
const DB_PATH = './database.db';
const USER_DB_DIR = './data-user';

// Create user data directory if it doesn't exist
if (!fs.existsSync(USER_DB_DIR)) {
    fs.mkdirSync(USER_DB_DIR);
}

// This variable will be updated on every data change.
let lastUpdateTimestamp = Date.now();
const touch = () => { lastUpdateTimestamp = Date.now(); };

// --- Serve Static Frontend Files ---
app.use(express.static(__dirname));


const createTables = (database) => {
    database.serialize(() => {
        // --- Existing Tables ---
        database.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, displayName TEXT, permissions TEXT, lastSeen INTEGER)`);
        database.run(`CREATE TABLE IF NOT EXISTS parts (id TEXT PRIMARY KEY, name TEXT, quantity REAL, itemsPerKg REAL, reorderPoint REAL, baseCount REAL, baseWeight REAL, reorderTriggeredDate TEXT, dailyUsage REAL, leadTime REAL, safetyStockDays REAL, material_cost REAL)`);
        database.run(`CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, partId TEXT, partName TEXT, operation TEXT, quantityChange REAL, weightChangeKg REAL, timestamp TEXT, snapshotQuantity REAL, snapshotWeightKg REAL)`);

        // --- Production & Shared Tables ---
        database.run(`CREATE TABLE IF NOT EXISTS workshops (id TEXT PRIMARY KEY, name TEXT UNIQUE)`);
        database.run(`CREATE TABLE IF NOT EXISTS raw_materials (id TEXT PRIMARY KEY, name TEXT UNIQUE, unit TEXT)`);
        database.run(`CREATE TABLE IF NOT EXISTS raw_material_transactions (id TEXT PRIMARY KEY, rawMaterialId TEXT, type TEXT, quantity REAL, notes TEXT, timestamp TEXT, wipJobId TEXT, workshopId TEXT)`);
        database.run(`CREATE TABLE IF NOT EXISTS wip_jobs (id TEXT PRIMARY KEY, rawMaterialId TEXT, workshopId TEXT, consumedQuantity REAL, timestamp TEXT, status TEXT, productions TEXT, completionAction TEXT, completionNotes TEXT, completionTimestamp TEXT)`);
        
        // --- Outsourcing Tables ---
        database.run(`CREATE TABLE IF NOT EXISTS outsourcing_parts (id TEXT PRIMARY KEY, name TEXT, description TEXT, isRawMaterialProduct BOOLEAN, weightDefinition TEXT, finalWorkshopIds TEXT)`);
        database.run(`CREATE TABLE IF NOT EXISTS outsourcing_transactions (id TEXT PRIMARY KEY, partId TEXT, type TEXT, quantity REAL, fromWorkshopId TEXT, toWorkshopId TEXT, notes TEXT, timestamp TEXT, lastEdited TEXT)`);
        database.run(`CREATE TABLE IF NOT EXISTS outsourcing_wages (workshopId TEXT, partId TEXT, wage REAL, PRIMARY KEY (workshopId, partId))`);
        database.run(`CREATE TABLE IF NOT EXISTS outsourcing_scrap_log (
            id TEXT PRIMARY KEY, 
            workshopId TEXT, 
            timestamp TEXT, 
            scrap_kg REAL, 
            process_description TEXT, 
            type TEXT, 
            sourcePartId TEXT, 
            resultingPartId TEXT, 
            sourceQuantity INTEGER, 
            originalScrapKg REAL, 
            destinationWorkshopId TEXT,
            returnedQuantity INTEGER,
            actualReturnedWeightKg REAL
        )`);

        // --- NEW: Workshop Finance Tables ---
        database.run(`CREATE TABLE IF NOT EXISTS workshop_finance_costs (id TEXT PRIMARY KEY, workshopId TEXT, partId TEXT, partName TEXT, quantity REAL, unitWage REAL, totalCost REAL, costBase TEXT, timestamp TEXT, isManual BOOLEAN)`);
        database.run(`CREATE TABLE IF NOT EXISTS workshop_finance_payments (id TEXT PRIMARY KEY, workshopId TEXT, amount REAL, paymentDate TEXT, chequeNumber TEXT, timestamp TEXT)`);

        // --- Calculator Table ---
        database.run(`CREATE TABLE IF NOT EXISTS calculator_saves (name TEXT PRIMARY KEY, data TEXT)`);
        
        // --- Bill of Materials (BOM) Tables ---
        database.run(`CREATE TABLE IF NOT EXISTS boms (id TEXT PRIMARY KEY, name TEXT UNIQUE)`);
        database.run(`CREATE TABLE IF NOT EXISTS bom_components (id TEXT PRIMARY KEY, bom_id TEXT, part_id TEXT, part_name TEXT, quantity REAL, cost REAL)`);
        database.run(`CREATE TABLE IF NOT EXISTS bom_simulations (name TEXT PRIMARY KEY, data TEXT)`);
    });
};

const applyMigrations = (database, dbName = 'main') => {
    database.serialize(() => {
        // Migration 1: Add reorderTriggeredDate to parts table
        database.run('ALTER TABLE parts ADD COLUMN reorderTriggeredDate TEXT', (err) => {
            if (err && err.message.includes('duplicate column name')) {
                // This is expected if the db is already migrated. Column already exists.
            } else if (err) {
                console.error(`Error migrating 'parts' table for ${dbName} DB:`, err.message);
            } else {
                console.log(`Migration successful: Added 'reorderTriggeredDate' to 'parts' table in ${dbName} DB.`);
            }
        });
        
        // Migration 2: Add columns to outsourcing_scrap_log for scrap correction feature
        const scrapLogColumns = [
            'type TEXT',
            'sourcePartId TEXT',
            'resultingPartId TEXT',
            'sourceQuantity INTEGER',
            'originalScrapKg REAL',
            'destinationWorkshopId TEXT',
            'returnedQuantity INTEGER',
            'actualReturnedWeightKg REAL'
        ];
        scrapLogColumns.forEach(columnDef => {
            const columnName = columnDef.split(' ')[0];
            database.run(`ALTER TABLE outsourcing_scrap_log ADD COLUMN ${columnDef}`, (err) => {
                 if (err && err.message.includes('duplicate column name')) {
                    // Column already exists, ignore.
                } else if (err) {
                    console.error(`Error adding column '${columnName}' to 'outsourcing_scrap_log' for ${dbName} DB:`, err.message);
                } else {
                    console.log(`Migration successful: Added '${columnName}' to 'outsourcing_scrap_log' in ${dbName} DB.`);
                }
            });
        });

        // Migration 3: Add reorder point optimization columns to parts table
        const partsOptColumns = ['dailyUsage REAL', 'leadTime REAL', 'safetyStockDays REAL'];
        partsOptColumns.forEach(columnDef => {
            const columnName = columnDef.split(' ')[0];
            database.run(`ALTER TABLE parts ADD COLUMN ${columnDef}`, (err) => {
                 if (err && err.message.includes('duplicate column name')) {
                    // Column already exists, ignore.
                } else if (err) {
                    console.error(`Error adding column '${columnName}' to 'parts' for ${dbName} DB:`, err.message);
                } else {
                    console.log(`Migration successful: Added '${columnName}' to 'parts' in ${dbName} DB.`);
                }
            });
        });
        
        // Migration 4: Add lastEdited column to outsourcing_transactions table
        database.run('ALTER TABLE outsourcing_transactions ADD COLUMN lastEdited TEXT', (err) => {
            if (err && err.message.includes('duplicate column name')) {
                // Column already exists, ignore.
            } else if (err) {
                console.error(`Error adding column 'lastEdited' to 'outsourcing_transactions' for ${dbName} DB:`, err.message);
            } else {
                console.log(`Migration successful: Added 'lastEdited' to 'outsourcing_transactions' in ${dbName} DB.`);
            }
        });

        // Migration 5: Add material_cost to parts table for BOM costing
        database.run('ALTER TABLE parts ADD COLUMN material_cost REAL DEFAULT 0', (err) => {
            if (err && err.message.includes('duplicate column name')) {
                // ignore
            } else if (err) {
                console.error(`Error adding column 'material_cost' to 'parts' for ${dbName} DB:`, err.message);
            } else {
                console.log(`Migration successful: Added 'material_cost' to 'parts' in ${dbName} DB.`);
            }
        });
    });
};

const seedInitialData = (database) => {
    database.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        if (err) {
            console.error("Error checking for users:", err.message);
            return;
        }

        if (row.count === 0) {
            console.log("No users found, creating default admin 'trade_master'.");
            const allPermissions = {
                canViewMainWarehouse: true,
                canEditMainWarehouse: true,
                canAddItems: true,
                canPerformTransactions: true,
                canEditItems: true,
                canDeleteItems: true,
                canViewProduction: true,
                canEditProduction: true,
                canViewOutsourcing: true,
                canEditOutsourcing: true,
                canViewWipReport: true,
                canEditWipReport: true,
                canViewWorkshopCosts: true,
                canEditWorkshopCosts: true,
                canViewUsers: true,
                canEditUsers: true,
            };

            database.run(`INSERT INTO users (id, username, password, displayName, permissions, lastSeen) VALUES (?, ?, ?, ?, ?, ?)`,
                ['default-admin-user', 'trade_master', '123', 'مدیر کل سیستم', JSON.stringify(allPermissions), null],
                (insertErr) => {
                    if (insertErr) {
                        console.error("Error creating default admin user:", insertErr.message);
                    } else {
                        console.log("Default admin 'trade_master' with password '123' created successfully.");
                        touch();
                    }
                }
            );
        }
    });
};

let mainDb = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error(err.message);
    else {
        console.log('Connected to the main inventory database.');
        mainDb.serialize(() => {
            createTables(mainDb);
            seedInitialData(mainDb);
            applyMigrations(mainDb, 'main'); // Apply migrations to main DB
        });
    }
});

// --- Multi-DB Handling ---
const dbConnections = { main: mainDb };

const getDbForUser = (username) => {
    if (dbConnections[username]) {
        return dbConnections[username];
    }
    const userDbPath = path.join(USER_DB_DIR, `${username}.db`);
    const userDb = new sqlite3.Database(userDbPath, (err) => {
        if (err) {
            console.error(`Error connecting to DB for user ${username}:`, err.message);
        } else {
            console.log(`Connected to DB for user ${username}.`);
            createTables(userDb);
            applyMigrations(userDb, username); // Apply migrations to user DB
        }
    });
    dbConnections[username] = userDb;
    return userDb;
};

// Middleware to select DB based on header
const withDb = (req, res, next) => {
    const userDbName = req.headers['x-user-db'];
    if (userDbName) {
        // Sanitize username to prevent path traversal attacks
        const safeUsername = path.basename(userDbName);
        if (safeUsername !== userDbName) {
            return res.status(400).json({ error: 'Invalid username format.' });
        }
        req.db = getDbForUser(safeUsername);
    } else {
        req.db = mainDb;
    }
    next();
};


// --- Helper Functions ---
const dbAll = (db, sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});
const dbRun = (db, sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
});
const dbGet = (db, sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbClose = (db) => new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve(null)));

const calculateAllPartStocks = async (db) => {
    const transactions = await dbAll(db, "SELECT * FROM outsourcing_transactions ORDER BY timestamp ASC");
    const stocks = {}; // { partId: { stockByWorkshop: { wsId: qty }, finishedGoodsStock: qty } }

    for (const tx of transactions) {
        if (!stocks[tx.partId]) {
            stocks[tx.partId] = { stockByWorkshop: {}, finishedGoodsStock: 0 };
        }
        
        const partStock = stocks[tx.partId];
        const qty = tx.quantity;

        switch (tx.type) {
            case 'ورود':
                if (tx.toWorkshopId) {
                    partStock.stockByWorkshop[tx.toWorkshopId] = (partStock.stockByWorkshop[tx.toWorkshopId] || 0) + qty;
                }
                break;
            case 'خروج':
                partStock.finishedGoodsStock -= qty;
                break;
            case 'انتقال':
                if (tx.fromWorkshopId) {
                     partStock.stockByWorkshop[tx.fromWorkshopId] = (partStock.stockByWorkshop[tx.fromWorkshopId] || 0) - qty;
                }
                if (tx.toWorkshopId === 'finished_goods_warehouse') {
                    partStock.finishedGoodsStock += qty;
                } else if (tx.toWorkshopId) {
                    // FIX: Do not add stock to internal/void destinations used for adjustments.
                    const adjustmentDestinations = ['void', 'void_adjustment', 'reset_adjustment_void', 'void_process_out'];
                    if (!adjustmentDestinations.includes(tx.toWorkshopId)) {
                        partStock.stockByWorkshop[tx.toWorkshopId] = (partStock.stockByWorkshop[tx.toWorkshopId] || 0) + qty;
                    }
                }
                break;
        }
    }
    return stocks;
};


// --- API Endpoints ---

// Check for updates
app.get('/api/last-update', (req, res) => res.json({ lastUpdate: lastUpdateTimestamp }));

// --- System/User Endpoints (always use main DB) ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await dbGet(mainDb, "SELECT * FROM users WHERE username = ? AND password = ?", [username, password]);
        if (user) {
            user.permissions = JSON.parse(user.permissions || '{}');
            // Ensure personal DB is created on login
            if (user.username !== 'trade_master') {
                getDbForUser(user.username);
            }
            res.json(user);
        } else {
            res.status(401).json({ error: 'نام کاربری یا رمز عبور نامعتبر است.' });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/users/lastseen/:id', async (req, res) => {
    try {
        await dbRun(mainDb, `UPDATE users SET lastSeen = ? WHERE id = ?`, [Date.now(), req.params.id]);
        res.sendStatus(200);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/:id', async (req, res) => {
    const { username: newUsername, password, displayName } = req.body;
    const { id: userId } = req.params;

    const currentUser = await dbGet(mainDb, "SELECT username FROM users WHERE id = ?", [userId]);
    if (!currentUser) {
        return res.status(404).json({ error: "User not found." });
    }
    const oldUsername = currentUser.username;
    const usernameChanged = oldUsername !== newUsername && oldUsername !== 'trade_master';
    
    let renamed = false;
    const oldDbPath = path.join(USER_DB_DIR, `${oldUsername}.db`);
    const newDbPath = path.join(USER_DB_DIR, `${newUsername}.db`);

    try {
        if (usernameChanged) {
            // This check handles an edge case where a DB file exists without a user record.
            if (fs.existsSync(newDbPath)) {
                return res.status(409).json({ error: "A database file for the new username already exists." });
            }

            // Close active DB connection for the old username if it exists in the cache
            if (dbConnections[oldUsername]) {
                await dbClose(dbConnections[oldUsername]);
                delete dbConnections[oldUsername];
            }

            // Rename the database file if it exists
            if (fs.existsSync(oldDbPath)) {
                fs.renameSync(oldDbPath, newDbPath);
                renamed = true; // Flag that we renamed
                console.log(`Renamed user DB from ${oldUsername}.db to ${newUsername}.db`);
            }
        }

        // Now update the user record in the main DB
        if (password) {
            await dbRun(mainDb, `UPDATE users SET username = ?, displayName = ?, password = ? WHERE id = ?`, [newUsername, displayName, password, userId]);
        } else {
            await dbRun(mainDb, `UPDATE users SET username = ?, displayName = ? WHERE id = ?`, [newUsername, displayName, userId]);
        }

        touch();
        res.status(200).json({ success: true });

    } catch (err) {
        // If we renamed the file but the DB update failed, rename it back.
        if (renamed) {
            try {
                fs.renameSync(newDbPath, oldDbPath);
                 console.log(`Rolled back DB file rename from ${newUsername}.db to ${oldUsername}.db`);
            } catch (renameErr) {
                console.error('CRITICAL ERROR: Failed to roll back file rename after DB error.', renameErr);
            }
        }
        
        console.error("Error updating user:", err.message);
        if (err.message.includes('UNIQUE constraint failed: users.username')) {
            return res.status(409).json({ error: 'این نام کاربری توسط کاربر دیگری استفاده شده است.' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users', async (req, res) => {
    const users = req.body;
    try {
        await dbRun(mainDb, "BEGIN TRANSACTION");
        for (const user of users) {
            await dbRun(mainDb, `UPDATE users SET username = ?, displayName = ?, permissions = ? WHERE id = ?`,
                [user.username, user.displayName, JSON.stringify(user.permissions), user.id]);
        }
        await dbRun(mainDb, "COMMIT");
        const updatedUsers = await dbAll(mainDb, "SELECT * FROM users");
        touch();
        res.status(200).json(updatedUsers.map(u => ({...u, permissions: JSON.parse(u.permissions || '{}')})));
    } catch (err) {
        await dbRun(mainDb, "ROLLBACK");
        res.status(500).json({ error: err.message });
    }
});
app.post('/api/users', async (req, res) => {
    const {id, username, password, displayName, permissions} = req.body;
    try {
        await dbRun(mainDb, `INSERT INTO users (id, username, password, displayName, permissions) VALUES (?, ?, ?, ?, ?)`, [id, username, password, displayName, JSON.stringify(permissions)]);
        // Create a personal DB for the new user
        getDbForUser(username);
        touch();
        res.status(201).json({ id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/users/:id', async (req, res) => {
    try {
        // Also delete the user's personal DB file
        const user = await dbGet(mainDb, `SELECT username FROM users WHERE id = ?`, [req.params.id]);
        if (user) {
            const userDbPath = path.join(USER_DB_DIR, `${user.username}.db`);
            if (dbConnections[user.username]) {
                await dbClose(dbConnections[user.username]);
                delete dbConnections[user.username];
            }
            if (fs.existsSync(userDbPath)) {
                fs.unlinkSync(userDbPath);
            }
        }
        await dbRun(mainDb, `DELETE FROM users WHERE id = ?`, [req.params.id]);
        touch();
        res.status(200).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Data Endpoints (use middleware to select DB) ---
app.get('/api/bootstrap', withDb, async (req, res) => {
    try {
        // Users always come from main DB
        const users = await dbAll(mainDb, "SELECT * FROM users");
        const parts = await dbAll(req.db, "SELECT * FROM parts");
        const transactions = await dbAll(req.db, "SELECT * FROM transactions ORDER BY timestamp DESC");
        const workshops = await dbAll(req.db, "SELECT * FROM workshops ORDER BY name");
        const rawMaterialTransactions = await dbAll(req.db, "SELECT * FROM raw_material_transactions ORDER BY timestamp DESC");
        const wages_flat = await dbAll(req.db, "SELECT * FROM outsourcing_wages");

        const wages = {};
        wages_flat.forEach(w => {
            if (!wages[w.partId]) wages[w.partId] = {};
            wages[w.partId][w.workshopId] = w.wage;
        });
        
        res.json({
            users: users.map(u => ({...u, permissions: JSON.parse(u.permissions || '{}')})),
            parts,
            transactions,
            workshops,
            rawMaterialTransactions,
            wages,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parts', withDb, async (req, res) => {
    const { id, name, quantity, itemsPerKg, reorderPoint, baseCount, baseWeight, reorderTriggeredDate, dailyUsage, leadTime, safetyStockDays } = req.body;
    try {
        await dbRun(req.db, `INSERT INTO parts (id, name, quantity, itemsPerKg, reorderPoint, baseCount, baseWeight, reorderTriggeredDate, dailyUsage, leadTime, safetyStockDays, material_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, name, quantity, itemsPerKg, reorderPoint, baseCount, baseWeight, reorderTriggeredDate || null, dailyUsage || null, leadTime || null, safetyStockDays || null, 0]);
        touch();
        res.status(201).json({ id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/parts/:id', withDb, async (req, res) => {
    const { name, quantity, itemsPerKg, reorderPoint, baseCount, baseWeight, reorderTriggeredDate, dailyUsage, leadTime, safetyStockDays } = req.body;
    try {
        const result = await dbRun(req.db, `UPDATE parts SET name = ?, quantity = ?, itemsPerKg = ?, reorderPoint = ?, baseCount = ?, baseWeight = ?, reorderTriggeredDate = ?, dailyUsage = ?, leadTime = ?, safetyStockDays = ? WHERE id = ?`, [name, quantity, itemsPerKg, reorderPoint, baseCount, baseWeight, reorderTriggeredDate || null, dailyUsage || null, leadTime || null, safetyStockDays || null, req.params.id]);
        touch();
        res.status(200).json({ updated: result.changes });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/parts/:id', withDb, async (req, res) => {
    try {
        await dbRun(req.db, "BEGIN TRANSACTION");
        const result = await dbRun(req.db, `DELETE FROM parts WHERE id = ?`, [req.params.id]);
        await dbRun(req.db, `DELETE FROM transactions WHERE partId = ?`, [req.params.id]);
        await dbRun(req.db, "COMMIT");
        touch();
        res.status(200).json({ deleted: result.changes });
    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/transactions', withDb, async (req, res) => {
    const { transactionRecord, partId, transactionQuantity, reorderTriggeredDate, costDestinations } = req.body;
    const { id, partName, operation, quantityChange, weightChangeKg, timestamp, snapshotQuantity, snapshotWeightKg } = transactionRecord;
    try {
        await dbRun(req.db, "BEGIN TRANSACTION");
        
        // 1. Record the main inventory transaction
        await dbRun(req.db, `INSERT INTO transactions (id, partId, partName, operation, quantityChange, weightChangeKg, timestamp, snapshotQuantity, snapshotWeightKg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [id, partId, partName, operation, quantityChange, weightChangeKg, timestamp, snapshotQuantity, snapshotWeightKg]);
        
        // 2. Update the part's stock
        await dbRun(req.db, `UPDATE parts SET quantity = quantity + ?, reorderTriggeredDate = ? WHERE id = ?`, 
            [transactionQuantity, reorderTriggeredDate, partId]);

        // 3. (NEW) If cost destinations are provided, create automatic cost entries
        if (costDestinations && Array.isArray(costDestinations) && costDestinations.length > 0) {
            for (const dest of costDestinations) {
                const wageRow = await dbGet(req.db, `SELECT wage FROM outsourcing_wages WHERE workshopId = ? AND partId = ?`, [dest.workshopId, partId]);
                
                if (wageRow && wageRow.wage > 0) {
                    const unitWage = wageRow.wage;
                    const costQuantity = dest.basis === 'weight' ? weightChangeKg : quantityChange;
                    const totalCost = costQuantity * unitWage;
                    const costId = `cost_auto_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                    
                    await dbRun(req.db, `INSERT INTO workshop_finance_costs (id, workshopId, partId, partName, quantity, unitWage, totalCost, costBase, timestamp, isManual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [costId, dest.workshopId, partId, partName, costQuantity, unitWage, totalCost, dest.basis, timestamp, false] // isManual = false
                    );
                }
            }
        }

        await dbRun(req.db, "COMMIT");
        touch();
        res.status(201).json({ success: true });
    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        console.error("Transaction Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- Calculator (calculator.html) Endpoints ---
app.get('/api/calculator/saves', withDb, async (req, res) => {
    try {
        const saves = await dbAll(req.db, "SELECT * FROM calculator_saves ORDER BY name");
        const result = {};
        saves.forEach(save => {
            result[save.name] = JSON.parse(save.data);
        });
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/calculator/saves', withDb, async (req, res) => {
    const { name, data } = req.body;
    try {
        await dbRun(req.db, `INSERT OR REPLACE INTO calculator_saves (name, data) VALUES (?, ?)`, [name, JSON.stringify(data)]);
        touch();
        res.status(201).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/calculator/saves/:name', withDb, async (req, res) => {
    try {
        await dbRun(req.db, `DELETE FROM calculator_saves WHERE name = ?`, [decodeURIComponent(req.params.name)]);
        touch();
        res.sendStatus(204);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// --- Production (production.html) Endpoints ---
app.get('/api/raw-materials-list', withDb, async (req, res) => {
    try {
        const rawMaterials = await dbAll(req.db, "SELECT id, name, unit FROM raw_materials ORDER BY name");
        res.json(rawMaterials);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/production/bootstrap', withDb, async (req, res) => {
    try {
        const workshops = await dbAll(req.db, "SELECT * FROM workshops ORDER BY name");
        const rawMaterials = await dbAll(req.db, "SELECT * FROM raw_materials ORDER BY name");
        const rawMaterialTransactions = await dbAll(req.db, "SELECT * FROM raw_material_transactions ORDER BY timestamp DESC");
        const wipJobs = await dbAll(req.db, "SELECT * FROM wip_jobs ORDER BY timestamp DESC");
        
        const allOutsourcingParts = await dbAll(req.db, "SELECT * FROM outsourcing_parts");
        const wages_flat = await dbAll(req.db, "SELECT * FROM outsourcing_wages");

        const wages = {};
        wages_flat.forEach(w => {
            if (!wages[w.workshopId]) wages[w.workshopId] = {};
            wages[w.workshopId][w.partId] = w.wage;
        });

        res.json({ 
            workshops, 
            rawMaterials, 
            rawMaterialTransactions, 
            wipJobs: wipJobs.map(j => ({...j, productions: JSON.parse(j.productions || '[]'), completionAction: JSON.parse(j.completionAction || '{}')})),
            parts: allOutsourcingParts.map(p => ({...p, weightDefinition: JSON.parse(p.weightDefinition || 'null')})),
            wages
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Workshops CRUD
app.post('/api/workshops', withDb, async (req, res) => {
    const { id, name } = req.body;
    try {
        await dbRun(req.db, `INSERT INTO workshops (id, name) VALUES (?, ?)`, [id, name]);
        touch();
        res.status(201).json({ id, name });
    } catch (err) { res.status(400).json({ error: "Workshop name must be unique." }); }
});
app.put('/api/workshops/:id', withDb, async (req, res) => {
    try {
        await dbRun(req.db, `UPDATE workshops SET name = ? WHERE id = ?`, [req.body.name, req.params.id]);
        touch();
        res.sendStatus(200);
    } catch (err) { res.status(400).json({ error: "Workshop name must be unique." }); }
});
app.delete('/api/workshops/:id', withDb, async (req, res) => {
    try {
        await dbRun(req.db, `DELETE FROM workshops WHERE id = ?`, [req.params.id]);
        touch();
        res.sendStatus(204);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Raw Materials CRUD
app.post('/api/raw-materials', withDb, async (req, res) => {
    const { id, name, unit } = req.body;
    try {
        await dbRun(req.db, `INSERT INTO raw_materials (id, name, unit) VALUES (?, ?, ?)`, [id, name, unit]);
        touch();
        res.status(201).json({ id, name, unit });
    } catch (err) { res.status(400).json({ error: "Raw material name must be unique." }); }
});
app.put('/api/raw-materials/:id', withDb, async (req, res) => {
    const { name } = req.body;
    try {
        await dbRun(req.db, `UPDATE raw_materials SET name = ? WHERE id = ?`, [name, req.params.id]);
        touch();
        res.sendStatus(200);
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            res.status(400).json({ error: "ماده اولیه‌ای با این نام از قبل وجود دارد." });
        } else {
            res.status(500).json({ error: err.message });
        }
    }
});
app.delete('/api/raw-materials/:id', withDb, async (req, res) => {
    try {
        await dbRun(req.db, `DELETE FROM raw_materials WHERE id = ?`, [req.params.id]);
        touch();
        res.sendStatus(204);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Raw Material Transactions CRUD
app.post('/api/raw-material-transactions', withDb, async (req, res) => {
    const { id, type, rawMaterialId, quantity, notes, timestamp } = req.body;
    try {
        await dbRun(req.db, `INSERT INTO raw_material_transactions (id, type, rawMaterialId, quantity, notes, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, type, rawMaterialId, quantity, notes, timestamp]);
        touch();
        res.status(201).json({ success: true, id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/raw-material-transactions/:id', withDb, async (req, res) => {
    const { quantity, notes, workshopId, timestamp } = req.body;
    try {
        const tx = await dbGet(req.db, `SELECT * FROM raw_material_transactions WHERE id = ?`, [req.params.id]);
        if (!tx) return res.status(404).json({ error: "Transaction not found." });

        const originalQuantity = tx.quantity;

        await dbRun(req.db, "BEGIN TRANSACTION");
        await dbRun(req.db, `UPDATE raw_material_transactions SET quantity = ?, notes = ?, workshopId = ?, timestamp = ? WHERE id = ?`, 
            [quantity, notes, workshopId, timestamp || tx.timestamp, req.params.id]);
        
        if (tx.wipJobId && tx.type === 'مصرف') {
            const quantityChange = quantity - originalQuantity;
            await dbRun(req.db, `UPDATE wip_jobs SET consumedQuantity = consumedQuantity + ? WHERE id = ?`, [quantityChange, tx.wipJobId]);
        }
        await dbRun(req.db, "COMMIT");
        touch();
        res.status(200).json({ success: true });
    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        res.status(500).json({ error: err.message });
    }
});
app.delete('/api/raw-material-transactions/:id', withDb, async (req, res) => {
    try {
        const tx = await dbGet(req.db, `SELECT * FROM raw_material_transactions WHERE id = ?`, [req.params.id]);
        if (!tx) return res.status(404).json({ error: "Transaction not found." });

        await dbRun(req.db, "BEGIN TRANSACTION");
        if (tx.wipJobId) {
            await dbRun(req.db, `DELETE FROM wip_jobs WHERE id = ?`, [tx.wipJobId]);
        }
        await dbRun(req.db, `DELETE FROM raw_material_transactions WHERE id = ?`, [req.params.id]);
        await dbRun(req.db, "COMMIT");
        touch();
        res.sendStatus(204);
    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        res.status(500).json({ error: err.message });
    }
});

// WIP Jobs
app.post('/api/wip-jobs', withDb, async (req, res) => {
    const { wipJob, rmTransaction } = req.body;
    try {
        await dbRun(req.db, "BEGIN TRANSACTION");
        await dbRun(req.db, `INSERT INTO wip_jobs (id, rawMaterialId, workshopId, consumedQuantity, timestamp, status, productions) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [wipJob.id, wipJob.rawMaterialId, wipJob.workshopId, wipJob.consumedQuantity, wipJob.timestamp, wipJob.status, '[]']);
        await dbRun(req.db, `INSERT INTO raw_material_transactions (id, rawMaterialId, type, quantity, notes, timestamp, wipJobId, workshopId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [rmTransaction.id, rmTransaction.rawMaterialId, rmTransaction.type, rmTransaction.quantity, rmTransaction.notes, rmTransaction.timestamp, rmTransaction.wipJobId, rmTransaction.workshopId]);
        await dbRun(req.db, "COMMIT");
        touch();
        res.status(201).json({ wipJobId: wipJob.id });
    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        res.status(500).json({ error: err.message });
    }
});
app.put('/api/wip-jobs/:id/add-material', withDb, async (req, res) => {
    const { id: jobId } = req.params;
    const { consumedQty, notes, timestamp } = req.body;

    try {
        const job = await dbGet(req.db, `SELECT * FROM wip_jobs WHERE id = ?`, [jobId]);
        if (!job) {
            return res.status(404).json({ error: "Job not found." });
        }
        if (job.status !== 'PENDING') {
            return res.status(400).json({ error: "Cannot add material to a completed job." });
        }

        const rmTransaction = {
            id: `rmtx_${Date.now()}`,
            type: 'مصرف',
            rawMaterialId: job.rawMaterialId,
            quantity: consumedQty,
            timestamp: timestamp || new Date().toISOString(),
            wipJobId: jobId,
            workshopId: job.workshopId,
            notes: notes || 'افزودن ماده اولیه به فرآیند موجود',
        };

        await dbRun(req.db, "BEGIN TRANSACTION");
        
        await dbRun(req.db, `UPDATE wip_jobs SET consumedQuantity = consumedQuantity + ? WHERE id = ?`, [consumedQty, jobId]);
        
        await dbRun(req.db, `INSERT INTO raw_material_transactions (id, rawMaterialId, type, quantity, notes, timestamp, wipJobId, workshopId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [rmTransaction.id, rmTransaction.rawMaterialId, rmTransaction.type, rmTransaction.quantity, rmTransaction.notes, rmTransaction.timestamp, rmTransaction.wipJobId, rmTransaction.workshopId]);

        await dbRun(req.db, "COMMIT");
        touch();
        res.status(200).json({ success: true, updatedJobId: jobId });

    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        res.status(500).json({ error: err.message });
    }
});
app.post('/api/wip-jobs/:id/produce', withDb, async (req, res) => {
    const { newProduction, newWeightDef } = req.body;
    const { partId, producedQty, destinationWorkshopId, timestamp } = newProduction;
    
    try {
        await dbRun(req.db, "BEGIN TRANSACTION");

        if (newWeightDef) {
             await dbRun(req.db, `UPDATE outsourcing_parts SET weightDefinition = ? WHERE id = ?`, [JSON.stringify(newWeightDef), partId]);
        }
        
        const job = await dbGet(req.db, `SELECT * FROM wip_jobs WHERE id = ?`, [req.params.id]);
        if (!job) throw new Error("Job not found");
        
        const rawMaterial = await dbGet(req.db, `SELECT * FROM raw_materials WHERE id = ?`, [job.rawMaterialId]);
        const workshop = await dbGet(req.db, `SELECT * FROM workshops WHERE id = ?`, [job.workshopId]);
        const transactionNotes = `تولید شده از ${rawMaterial?.name || 'ماده اولیه'} در کارگاه ${workshop?.name || 'نامشخص'}`;

        // Create transaction and get its ID
        const transactionId = `tx_prod_${Date.now()}_${Math.random()}`;
        await dbRun(req.db, `INSERT INTO outsourcing_transactions (id, partId, type, quantity, fromWorkshopId, toWorkshopId, notes, timestamp) VALUES (?, ?, 'ورود', ?, ?, ?, ?, ?)`,
            [transactionId, partId, producedQty, null, destinationWorkshopId, transactionNotes, timestamp]);
        
        // Add transactionId to production record before saving
        newProduction.transactionId = transactionId; 
        
        const productions = JSON.parse(job.productions || '[]')
        productions.push(newProduction);
        await dbRun(req.db, `UPDATE wip_jobs SET productions = ? WHERE id = ?`, [JSON.stringify(productions), req.params.id]);

        await dbRun(req.db, "COMMIT");
        touch();
        res.status(200).json({ success: true });
    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        console.error("Error in /produce endpoint:", err);
        res.status(500).json({ error: err.message });
    }
});
app.put('/api/wip-jobs/:id/productions/adjust', withDb, async (req, res) => {
    const { id: jobId } = req.params;
    const { productionTimestamp, newProducedQty, newScrapQuantity, newScrapNotes, newPartId, newTimestamp } = req.body;
    
    try {
        await dbRun(req.db, "BEGIN TRANSACTION");

        const job = await dbGet(req.db, `SELECT * FROM wip_jobs WHERE id = ?`, [jobId]);
        if (!job) throw new Error("Job not found");
        if (job.status !== 'PENDING') throw new Error("Cannot edit a completed job.");

        let productions = JSON.parse(job.productions || '[]');
        const productionIndex = productions.findIndex(p => p.timestamp === productionTimestamp);
        if (productionIndex === -1) throw new Error("Production record not found");

        const originalProduction = productions[productionIndex];
        let transactionToUpdateId = originalProduction.transactionId;
        
        // --- Backward Compatibility: Find transaction if ID is missing ---
        if (!transactionToUpdateId) {
            console.log(`Legacy production record detected (timestamp: ${originalProduction.timestamp}). Searching for matching transaction...`);
            const legacyTx = await dbGet(req.db,
                `SELECT id FROM outsourcing_transactions WHERE partId = ? AND quantity = ? AND timestamp = ? AND type = 'ورود'`,
                [originalProduction.partId, originalProduction.producedQty, originalProduction.timestamp]
            );

            if (legacyTx) {
                console.log(`Found matching transaction ID: ${legacyTx.id}. Linking to production record.`);
                transactionToUpdateId = legacyTx.id;
            } else {
                // If we still can't find it, we have a data integrity issue.
                throw new Error("Could not find the original transaction for this legacy production record. Cannot safely edit.");
            }
        }
        // --- End Backward Compatibility ---

        if (!transactionToUpdateId) {
            // This case should ideally not be reached because of the legacy check above.
             throw new Error("Production record is missing its transaction link. Cannot safely edit.");
        }

        // 1. Update the original transaction in outsourcing_transactions
        await dbRun(req.db, 
            `UPDATE outsourcing_transactions SET partId = ?, quantity = ?, timestamp = ?, lastEdited = ? WHERE id = ?`,
            [newPartId, newProducedQty, newTimestamp, new Date().toISOString(), transactionToUpdateId]
        );
        
        // 2. Update the production record in the job's JSON
        productions[productionIndex] = {
            ...originalProduction,
            transactionId: transactionToUpdateId, // Ensure the ID is now stored
            partId: newPartId,
            producedQty: newProducedQty,
            scrapQuantity: newScrapQuantity,
            scrapNotes: newScrapNotes,
            timestamp: newTimestamp // Update the timestamp key, which is the record's primary identifier within the JSON
        };
        
        await dbRun(req.db, `UPDATE wip_jobs SET productions = ? WHERE id = ?`, [JSON.stringify(productions), jobId]);

        await dbRun(req.db, "COMMIT");
        touch();
        res.status(200).json({ success: true });

    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        console.error("Error adjusting production:", err);
        let errorMessage = err.message;
        if (err.message.includes("legacy production record")) {
            errorMessage = "تراکنش اصلی مربوط به این رکورد تولید قدیمی یافت نشد. ویرایش امکان‌پذیر نیست.";
        }
        res.status(500).json({ error: errorMessage });
    }
});
app.put('/api/wip-jobs/:id/complete', withDb, async (req, res) => {
    const { completionAction, completionNotes, returnTransaction } = req.body;
    try {
        await dbRun(req.db, "BEGIN TRANSACTION");
        
        await dbRun(req.db, `UPDATE wip_jobs SET status = 'COMPLETED', completionAction = ?, completionNotes = ?, completionTimestamp = ? WHERE id = ?`,
            [JSON.stringify(completionAction), completionNotes, new Date().toISOString(), req.params.id]);
            
        if (returnTransaction) {
            await dbRun(req.db, `INSERT INTO raw_material_transactions (id, rawMaterialId, type, quantity, notes, timestamp) VALUES (?, ?, 'خرید', ?, ?, ?)`,
                [returnTransaction.id, returnTransaction.rawMaterialId, returnTransaction.quantity, returnTransaction.notes, returnTransaction.timestamp]);
        }
        
        await dbRun(req.db, "COMMIT");
        touch();
        res.status(200).json({ success: true });
    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        res.status(500).json({ error: err.message });
    }
});
app.delete('/api/wip-jobs/:id', withDb, async (req, res) => {
    try {
        await dbRun(req.db, `DELETE FROM wip_jobs WHERE id = ?`, [req.params.id]);
        touch();
        res.sendStatus(204);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Outsourcing (outsourcing.html) Endpoints ---
app.get('/api/outsourcing/bootstrap', withDb, async (req, res) => {
    try {
        const parts = await dbAll(req.db, "SELECT * FROM outsourcing_parts ORDER BY name");
        const transactions = await dbAll(req.db, "SELECT * FROM outsourcing_transactions ORDER BY timestamp DESC");
        const workshops = await dbAll(req.db, "SELECT * FROM workshops ORDER BY name");
        const wages_flat = await dbAll(req.db, "SELECT * FROM outsourcing_wages");
        const scrapLog = await dbAll(req.db, "SELECT * FROM outsourcing_scrap_log ORDER BY timestamp DESC");
        
        const calculatedStocks = await calculateAllPartStocks(req.db);

        const wages = {};
        wages_flat.forEach(w => {
            if (!wages[w.workshopId]) wages[w.workshopId] = {};
            wages[w.workshopId][w.partId] = w.wage;
        });
        
        const partsWithStock = parts.map(p => {
            const stockInfo = calculatedStocks[p.id] || { stockByWorkshop: {}, finishedGoodsStock: 0 };
            return {
                ...p,
                weightDefinition: JSON.parse(p.weightDefinition || 'null'),
                finalWorkshopIds: JSON.parse(p.finalWorkshopIds || '[]'),
                ...stockInfo
            };
        });

        res.json({
            parts: partsWithStock,
            transactions,
            workshops,
            wages,
            scrapLog
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/outsourcing/parts', withDb, async (req, res) => {
    const { id, name, description, isRawMaterialProduct, weightDefinition, finalWorkshopIds } = req.body;
    try {
        await dbRun(req.db, `INSERT INTO outsourcing_parts (id, name, description, isRawMaterialProduct, weightDefinition, finalWorkshopIds) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, name, description, isRawMaterialProduct, JSON.stringify(weightDefinition), JSON.stringify(finalWorkshopIds)]);
        touch();
        res.status(201).json({ id });
    } catch (err) { res.status(400).json({ error: "Part name must be unique or data is invalid." }); }
});

app.put('/api/outsourcing/parts/:id', withDb, async (req, res) => {
    const { name, description, isRawMaterialProduct, weightDefinition, finalWorkshopIds } = req.body;
    try {
        await dbRun(req.db, `UPDATE outsourcing_parts SET name = ?, description = ?, isRawMaterialProduct = ?, weightDefinition = ?, finalWorkshopIds = ? WHERE id = ?`,
            [name, description, isRawMaterialProduct, JSON.stringify(weightDefinition), JSON.stringify(finalWorkshopIds), req.params.id]);
        touch();
        res.sendStatus(200);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/outsourcing/parts/:id', withDb, async (req, res) => {
    try {
        await dbRun(req.db, "BEGIN TRANSACTION");
        await dbRun(req.db, `DELETE FROM outsourcing_parts WHERE id = ?`, [req.params.id]);
        await dbRun(req.db, `DELETE FROM outsourcing_transactions WHERE partId = ?`, [req.params.id]);
        await dbRun(req.db, `DELETE FROM outsourcing_wages WHERE partId = ?`, [req.params.id]);
        await dbRun(req.db, "COMMIT");
        touch();
        res.sendStatus(204);
    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/outsourcing/transactions', withDb, async (req, res) => {
    const { transaction } = req.body;
    try {
        await dbRun(req.db, `INSERT INTO outsourcing_transactions (id, partId, type, quantity, fromWorkshopId, toWorkshopId, notes, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [transaction.id, transaction.partId, transaction.type, transaction.quantity, transaction.fromWorkshopId, transaction.toWorkshopId, transaction.notes, transaction.timestamp]);
        touch();
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/outsourcing/process-transaction', withDb, async (req, res) => {
    // Renaming 'quantity' from body to 'sourceQuantity' for clarity
    const { sourcePartId, fromWorkshopId, quantity: sourceQuantity, resultingPartId, toWorkshopId, timestamp, actualResultingWeightKg, returnedQuantity } = req.body;
    try {
        await dbRun(req.db, "BEGIN TRANSACTION");

        const sourcePart = await dbGet(req.db, "SELECT * FROM outsourcing_parts WHERE id = ?", [sourcePartId]);
        const resultingPart = await dbGet(req.db, "SELECT * FROM outsourcing_parts WHERE id = ?", [resultingPartId]);

        // Transaction 1: Source part out (always use sourceQuantity)
        const txOutId = `tx_proc_out_${Date.now()}`;
        const noteOut = `پردازش و تبدیل به '${resultingPart.name}'`;
        await dbRun(req.db, `INSERT INTO outsourcing_transactions (id, partId, type, quantity, fromWorkshopId, toWorkshopId, notes, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [txOutId, sourcePartId, 'انتقال', sourceQuantity, fromWorkshopId, 'void_process_out', noteOut, timestamp]);

        // Transaction 2: Resulting part in (use returnedQuantity)
        if (returnedQuantity > 0) {
            const txInId = `tx_proc_in_${Date.now()}`;
            const noteIn = `تولید شده از '${sourcePart.name}'`;
            await dbRun(req.db, `INSERT INTO outsourcing_transactions (id, partId, type, quantity, toWorkshopId, notes, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [txInId, resultingPartId, 'ورود', returnedQuantity, toWorkshopId, noteIn, timestamp]);
        }
        
        // Advanced Scrap logging
        const sourceWeightDef = JSON.parse(sourcePart.weightDefinition || 'null');
        const resultingWeightDef = JSON.parse(resultingPart.weightDefinition || 'null');
        
        let totalScrapKg = 0;
        let processDescription = `از تبدیل ${sourceQuantity} عدد '${sourcePart.name}' به '${resultingPart.name}'.`;

        if (sourceWeightDef && sourceWeightDef.baseQuantity > 0 && sourceWeightDef.baseWeight > 0 && actualResultingWeightKg !== undefined) {
            const sourceUnitWeightKg = (sourceWeightDef.weightUnit === 'g' ? sourceWeightDef.baseWeight / 1000 : sourceWeightDef.baseWeight) / sourceWeightDef.baseQuantity;
            const sourceTotalWeightKg = sourceQuantity * sourceUnitWeightKg;
            
            totalScrapKg = sourceTotalWeightKg - actualResultingWeightKg;
            
            let processScrapKg = 0;
            let componentLossScrapKg = 0;
            const missingPieces = sourceQuantity - returnedQuantity;

            if (resultingWeightDef && resultingWeightDef.baseQuantity > 0 && resultingWeightDef.baseWeight > 0) {
                 const resultingUnitWeightKg = (resultingWeightDef.weightUnit === 'g' ? resultingWeightDef.baseWeight / 1000 : resultingWeightDef.baseWeight) / resultingWeightDef.baseQuantity;
                 const expectedTotalResultWeightKg = sourceQuantity * resultingUnitWeightKg;
                 const actualExpectedWeightForReturnedQty = returnedQuantity * resultingUnitWeightKg;
                 
                 processScrapKg = sourceTotalWeightKg - expectedTotalResultWeightKg;
                 componentLossScrapKg = expectedTotalResultWeightKg - actualExpectedWeightForReturnedQty;
                 
                 processDescription += ` کل ضایعات: ${totalScrapKg.toFixed(3)} ک‌گ (ضایعات فرآیند: ${Math.max(0, processScrapKg).toFixed(3)} ک‌گ، کسری/خرابی: ${Math.max(0, componentLossScrapKg).toFixed(3)} ک‌گ بابت ${missingPieces} قطعه)`;
            } else {
                 processDescription += ` کل ضایعات: ${totalScrapKg.toFixed(3)} ک‌گ (وزن قطعه مقصد تعریف نشده است).`;
            }

            if (totalScrapKg > 1e-6) { // Only log if there's actual scrap
                const scrapId = `scrap_${Date.now()}`;
                await dbRun(req.db, `INSERT INTO outsourcing_scrap_log (id, workshopId, timestamp, scrap_kg, originalScrapKg, process_description, type, sourcePartId, resultingPartId, sourceQuantity, destinationWorkshopId, returnedQuantity, actualReturnedWeightKg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [scrapId, fromWorkshopId, timestamp, totalScrapKg, totalScrapKg, processDescription, 'CONVERSION', sourcePartId, resultingPartId, sourceQuantity, toWorkshopId, returnedQuantity, actualResultingWeightKg]);
            }
        }

        await dbRun(req.db, "COMMIT");
        touch();
        res.status(201).json({ success: true });
    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        console.error("Error processing transaction:", err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/outsourcing/transactions/:id', withDb, async (req, res) => {
    const { quantity, fromWorkshopId, toWorkshopId, notes } = req.body;
    try {
        await dbRun(req.db, `UPDATE outsourcing_transactions SET quantity = ?, fromWorkshopId = ?, toWorkshopId = ?, notes = ?, lastEdited = ? WHERE id = ?`, [quantity, fromWorkshopId, toWorkshopId, notes, new Date().toISOString(), req.params.id]);
        touch();
        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/outsourcing/wages', withDb, async (req, res) => {
    const { workshopId, partId, wage } = req.body;
    try {
        await dbRun(req.db, `INSERT OR REPLACE INTO outsourcing_wages (workshopId, partId, wage) VALUES (?, ?, ?)`, [workshopId, partId, wage]);
        touch();
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/outsourcing/wages', withDb, async (req, res) => {
    const { workshopId, partId } = req.body;
    try {
        await dbRun(req.db, `DELETE FROM outsourcing_wages WHERE workshopId = ? AND partId = ?`, [workshopId, partId]);
        touch();
        res.sendStatus(204);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/outsourcing/scrap-log/correct', withDb, async (req, res) => {
    const { scrapLogId, recoveredQuantity, newDestinationWorkshopId } = req.body;
    try {
        await dbRun(req.db, "BEGIN TRANSACTION");

        const log = await dbGet(req.db, `SELECT * FROM outsourcing_scrap_log WHERE id = ?`, [scrapLogId]);
        if (!log) throw new Error("Scrap log not found.");
        if (log.type !== 'CONVERSION') throw new Error("Only conversion scrap can be corrected this way.");

        const missingPieces = log.sourceQuantity - log.returnedQuantity;
        if(recoveredQuantity > missingPieces) throw new Error("Cannot recover more pieces than were missing.");

        const resultingPart = await dbGet(req.db, "SELECT * FROM outsourcing_parts WHERE id = ?", [log.resultingPartId]);
        if (!resultingPart) throw new Error("Resulting part from original process not found.");
        const weightDef = JSON.parse(resultingPart.weightDefinition || 'null');
        if (!weightDef || !weightDef.baseQuantity || !weightDef.baseWeight) throw new Error("Weight definition for resulting part is missing.");

        const unitWeightKg = (weightDef.weightUnit === 'g' ? weightDef.baseWeight / 1000 : weightDef.baseWeight) / weightDef.baseQuantity;
        const recoveredWeightKg = recoveredQuantity * unitWeightKg;
        
        if (recoveredWeightKg > log.scrap_kg + 1e-6) throw new Error("Recovered weight cannot exceed remaining scrap weight.");

        // 1. Update scrap log
        const newScrapKg = log.scrap_kg - recoveredWeightKg;
        const newReturnedQty = log.returnedQuantity + recoveredQuantity;
        const correctionNote = `\n(اصلاحیه در ${new Date().toLocaleString('fa-IR')}: ${recoveredQuantity} قطعه به وزن ${recoveredWeightKg.toFixed(3)} ک‌گ بازیابی شد.)`;
        const newDescription = log.process_description + correctionNote;
        await dbRun(req.db, `UPDATE outsourcing_scrap_log SET scrap_kg = ?, process_description = ?, returnedQuantity = ? WHERE id = ?`, [newScrapKg, newDescription, newReturnedQty, scrapLogId]);

        // 2. Create new transaction for the recovered part
        if (recoveredQuantity > 0) {
            const finalDestinationWorkshopId = newDestinationWorkshopId || log.destinationWorkshopId;
            if (!finalDestinationWorkshopId) throw new Error("Destination workshop ID is missing for the recovery transaction.");

            const txId = `tx_corr_${Date.now()}`;
            const txNote = `بازیابی از ضایعات تبدیل (شناسه ضایعات: ${scrapLogId.slice(-6)})`;
            await dbRun(req.db, `INSERT INTO outsourcing_transactions (id, partId, type, quantity, toWorkshopId, notes, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [txId, log.resultingPartId, 'ورود', recoveredQuantity, finalDestinationWorkshopId, txNote, new Date().toISOString()]);
        }

        await dbRun(req.db, "COMMIT");
        touch();
        res.status(200).json({ success: true });
    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        console.error("Error correcting scrap log:", err);
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/outsourcing/parts/:id/reset-stock', withDb, async (req, res) => {
    const { id: partId } = req.params;
    const { resetWip, resetFinished } = req.body;

    try {
        await dbRun(req.db, "BEGIN TRANSACTION");

        const calculatedStocks = await calculateAllPartStocks(req.db);
        const stockInfo = calculatedStocks[partId] || { stockByWorkshop: {}, finishedGoodsStock: 0 };

        const timestamp = new Date().toISOString();
        const notes = "ریست دستی موجودی";

        if (resetWip) {
            for (const [workshopId, quantity] of Object.entries(stockInfo.stockByWorkshop)) {
                if (quantity > 0) {
                    await dbRun(req.db, `INSERT INTO outsourcing_transactions (id, partId, type, quantity, fromWorkshopId, toWorkshopId, notes, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [`tx_reset_wip_${Date.now()}_${Math.random()}`, partId, 'انتقال', quantity, workshopId, 'reset_adjustment_void', notes, timestamp]);
                }
            }
        }

        if (resetFinished) {
            if (stockInfo.finishedGoodsStock > 0) {
                await dbRun(req.db, `INSERT INTO outsourcing_transactions (id, partId, type, quantity, notes, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
                    [`tx_reset_fin_${Date.now()}_${Math.random()}`, partId, 'خروج', stockInfo.finishedGoodsStock, notes, timestamp]);
            }
        }

        await dbRun(req.db, "COMMIT");
        touch();
        res.status(200).json({ success: true });
    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        console.error("Error resetting part stock:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/outsourcing/global-reset-stock', withDb, async (req, res) => {
    try {
        await dbRun(req.db, "BEGIN TRANSACTION");

        const calculatedStocks = await calculateAllPartStocks(req.db);
        const parts = await dbAll(req.db, "SELECT id FROM outsourcing_parts");

        const timestamp = new Date().toISOString();
        const notes = "ریست کلی موجودی نهایی";
        let resetCount = 0;

        for (const part of parts) {
            const stockInfo = calculatedStocks[part.id] || { stockByWorkshop: {}, finishedGoodsStock: 0 };
            const totalWipStock = Object.values(stockInfo.stockByWorkshop).reduce((sum, qty) => sum + qty, 0);

            if (totalWipStock === 0 && stockInfo.finishedGoodsStock > 0) {
                 await dbRun(req.db, `INSERT INTO outsourcing_transactions (id, partId, type, quantity, notes, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
                    [`tx_greset_fin_${Date.now()}_${Math.random()}`, part.id, 'خروج', stockInfo.finishedGoodsStock, notes, timestamp]);
                resetCount++;
            }
        }

        await dbRun(req.db, "COMMIT");
        touch();
        res.status(200).json({ success: true, resetCount });
    } catch (err) {
        await dbRun(req.db, "ROLLBACK");
        console.error("Error in global stock reset:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- WIP Report (wip_report.html) Endpoints ---
app.get('/api/reports/wip', withDb, async (req, res) => {
    try {
        const parts = await dbAll(req.db, "SELECT * FROM outsourcing_parts");
        const workshops = await dbAll(req.db, "SELECT * FROM workshops");
        
        const getWorkshopName = (id) => {
            const workshop = workshops.find(w => w.id === id);
            return workshop ? workshop.name : 'کارگاه حذف شده';
        };

        const calculatedStocks = await calculateAllPartStocks(req.db);
        const transactions = await dbAll(req.db, "SELECT * FROM outsourcing_transactions ORDER BY timestamp ASC"); // oldest first

        const reportItems = [];

        for (const part of parts) {
            const stockInfo = calculatedStocks[part.id];
            if (!stockInfo) continue;

            const stockByWorkshop = stockInfo.stockByWorkshop;
            const weightDefinition = JSON.parse(part.weightDefinition || 'null');

            for (const [workshopId, quantity] of Object.entries(stockByWorkshop)) {
                if (quantity <= 0) continue;

                let totalWeight = 0;
                let weightUnit = '';
                if (weightDefinition && weightDefinition.baseQuantity > 0 && weightDefinition.baseWeight > 0) {
                    totalWeight = (quantity / weightDefinition.baseQuantity) * weightDefinition.baseWeight;
                    weightUnit = weightDefinition.weightUnit || 'kg';
                }

                const entryTxs = transactions.filter(tx => tx.partId === part.id && (tx.type === 'ورود' || tx.type === 'انتقال') && tx.toWorkshopId === workshopId);

                // FIFO Aging: Oldest items are transferred out first. The remaining stock is composed of the newest items.
                const totalIn = entryTxs.reduce((sum, tx) => sum + tx.quantity, 0);
                const totalOut = totalIn - quantity; // `quantity` is remaining stock

                let qtyToConsume = totalOut;
                const remainingLotsRaw = [];
                for (const tx of entryTxs) { // entryTxs is sorted oldest to newest
                    if (qtyToConsume <= 0) {
                        remainingLotsRaw.push({...tx});
                        continue;
                    }

                    const consumedFromThisTx = Math.min(qtyToConsume, tx.quantity);
                    const remainingInThisTx = tx.quantity - consumedFromThisTx;

                    if (remainingInThisTx > 0) {
                        remainingLotsRaw.push({...tx, quantity: remainingInThisTx });
                    }
                    
                    qtyToConsume -= consumedFromThisTx;
                }

                const stockLots = remainingLotsRaw.map(lot => {
                    let lotWeight = 0;
                    if (weightDefinition && weightDefinition.baseQuantity > 0 && weightDefinition.baseWeight > 0) {
                        lotWeight = (lot.quantity / weightDefinition.baseQuantity) * weightDefinition.baseWeight;
                    }
                    return { date: new Date(lot.timestamp), quantity: lot.quantity, notes: lot.notes || '', weight: lotWeight, weightUnit };
                });
                
                if (stockLots.length > 0) {
                    // With FIFO, the oldest lot of the *remaining* stock determines the age.
                    const oldestEntryDate = stockLots[0].date;
                    const sevenDaysAgo = new Date(new Date().setDate(new Date().getDate() - 7));
                    
                    reportItems.push({
                        partId: part.id,
                        workshopId: workshopId,
                        partName: part.name,
                        workshopName: getWorkshopName(workshopId),
                        quantity,
                        totalWeight,
                        weightUnit,
                        oldestEntryDate: oldestEntryDate.toISOString(),
                        entryLots: stockLots.map(lot => ({...lot, date: lot.date.toISOString()})),
                        isUrgent: oldestEntryDate < sevenDaysAgo,
                    });
                }
            }
        }
        res.json(reportItems);
    } catch (err) {
        console.error("WIP Report Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/reports/wip/adjust-stock', withDb, async (req, res) => {
    const { partId, workshopId, adjustment, userNotes } = req.body;
    
    if (adjustment === 0 && !userNotes) {
        return res.status(200).json({ message: "No change needed." });
    }

    try {
        const calculatedStocks = await calculateAllPartStocks(req.db);
        const partStock = calculatedStocks[partId] || { stockByWorkshop: {} };
        const currentStock = partStock.stockByWorkshop[workshopId] || 0;
        const newStock = currentStock + adjustment;

        if (newStock < 0) {
            throw new Error("Adjustment results in negative stock.");
        }
        
        if(adjustment !== 0) {
            const automaticNote = `اصلاحیه دستی موجودی از ${currentStock.toLocaleString('fa-IR')} به ${newStock.toLocaleString('fa-IR')}.`;
            const finalNote = userNotes ? `${automaticNote} یادداشت: ${userNotes}` : automaticNote;

            const txType = adjustment > 0 ? 'ورود' : 'انتقال';
            const newTransaction = {
                id: `tx_adj_${Date.now()}`,
                partId: partId,
                type: txType,
                quantity: Math.abs(adjustment),
                fromWorkshopId: adjustment < 0 ? workshopId : null,
                toWorkshopId: adjustment > 0 ? workshopId : 'void_adjustment', // 'void' indicates a write-off/loss
                notes: finalNote,
                timestamp: new Date().toISOString()
            };
            
            await dbRun(req.db, `INSERT INTO outsourcing_transactions (id, partId, type, quantity, fromWorkshopId, toWorkshopId, notes, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [newTransaction.id, newTransaction.partId, newTransaction.type, newTransaction.quantity, newTransaction.fromWorkshopId, newTransaction.toWorkshopId, newTransaction.notes, newTransaction.timestamp]);
        }
        
        touch();
        res.status(200).json({ success: true, newStock: newStock });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Bill of Materials (BOM) Endpoints ---
app.get('/api/bom/data', withDb, async (req, res) => {
    try {
        const boms = await dbAll(req.db, "SELECT * FROM boms ORDER BY name");
        const components = await dbAll(req.db, "SELECT * FROM bom_components");
        const simulations = await dbAll(req.db, "SELECT * FROM bom_simulations ORDER BY name");
        const inventoryParts = await dbAll(mainDb, "SELECT id, name, quantity, material_cost FROM parts ORDER BY name");
        const wages_flat = await dbAll(req.db, "SELECT * FROM outsourcing_wages");
        const workshops = await dbAll(req.db, "SELECT * FROM workshops");

        const wages = {};
        wages_flat.forEach(w => {
            if (!wages[w.partId]) {
                wages[w.partId] = {};
            }
            wages[w.partId][w.workshopId] = w.wage;
        });

        const componentsByBomId = components.reduce((acc, comp) => {
            if (!acc[comp.bom_id]) {
                acc[comp.bom_id] = [];
            }
            acc[comp.bom_id].push(comp);
            return acc;
        }, {});
        
        const bomsWithComponents = boms.map(bom => ({
            ...bom,
            components: componentsByBomId[bom.id] || []
        }));

        res.json({
            boms: bomsWithComponents,
            simulations: simulations.map(sim => ({ ...sim, data: JSON.parse(sim.data || '{}') })),
            inventoryParts,
            wages,
            workshops,
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/bom', withDb, (req, res) => {
    const { id, name, components } = req.body;
    if (!id || !name || !Array.isArray(components)) {
        return res.status(400).json({ error: "Invalid data provided." });
    }
    const db = req.db;

    // Distinguish between create and update by checking if the ID exists
    db.get("SELECT id FROM boms WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: `DB error on ID check: ${err.message}` });

        const isUpdate = !!row;
        // If updating, check if new name conflicts with any OTHER bom.
        // If creating, check if new name conflicts with ANY bom.
        const uniquenessCheckSql = isUpdate 
            ? "SELECT id FROM boms WHERE name = ? AND id != ?" 
            : "SELECT id FROM boms WHERE name = ?";
        const uniquenessCheckParams = isUpdate ? [name, id] : [name];

        db.get(uniquenessCheckSql, uniquenessCheckParams, (err, conflictingRow) => {
            if (err) return res.status(500).json({ error: `DB error on name check: ${err.message}` });
            if (conflictingRow) {
                return res.status(409).json({ error: 'محصولی با این نام از قبل وجود دارد.' });
            }

            // All checks passed, perform transaction
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                db.run("INSERT OR REPLACE INTO boms (id, name) VALUES (?, ?)", [id, name]);
                db.run("DELETE FROM bom_components WHERE bom_id = ?", [id]);
                if (components.length > 0) {
                    const stmt = db.prepare("INSERT INTO bom_components (id, bom_id, part_id, part_name, quantity, cost) VALUES (?, ?, ?, ?, ?, ?)");
                    for (const comp of components) {
                        stmt.run([comp.id, id, comp.part_id, comp.part_name, comp.quantity, comp.cost]);
                    }
                    stmt.finalize();
                }
                db.run("COMMIT", (commitErr) => {
                    if (commitErr) {
                        console.error("BOM Save Commit Error:", commitErr.message);
                        db.run("ROLLBACK"); // Attempt rollback
                        return res.status(500).json({ error: `Commit failed: ${commitErr.message}` });
                    }
                    touch();
                    res.status(201).json({ success: true, id });
                });
            });
        });
    });
});

app.delete('/api/bom/:id', withDb, async (req, res) => {
    try {
        await dbRun(req.db, "BEGIN TRANSACTION");
        await dbRun(req.db, "DELETE FROM bom_components WHERE bom_id = ?", [req.params.id]);
        await dbRun(req.db, "DELETE FROM boms WHERE id = ?", [req.params.id]);
        await dbRun(req.db, "COMMIT");
        touch();
        res.sendStatus(204);
    } catch(err) {
        await dbRun(req.db, "ROLLBACK");
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/bom/parts/:id/cost', withDb, async (req, res) => {
    const { id: partId } = req.params;
    const { materialCost, totalCalculatedCost } = req.body;

    if (typeof materialCost === 'undefined' || typeof totalCalculatedCost === 'undefined') {
        return res.status(400).json({ error: "Missing materialCost or totalCalculatedCost." });
    }

    const areDbsSame = (req.db === mainDb);

    try {
        if (areDbsSame) {
            await dbRun(mainDb, "BEGIN TRANSACTION");
        } else {
            await dbRun(mainDb, "BEGIN TRANSACTION");
            await dbRun(req.db, "BEGIN TRANSACTION");
        }

        // Update material_cost in the main inventory parts table (mainDb)
        await dbRun(mainDb, `UPDATE parts SET material_cost = ? WHERE id = ?`, [materialCost, partId]);

        // Update the cost in all BOMs that use this part (req.db)
        await dbRun(req.db, `UPDATE bom_components SET cost = ? WHERE part_id = ?`, [totalCalculatedCost, partId]);

        if (areDbsSame) {
            await dbRun(mainDb, "COMMIT");
        } else {
            await dbRun(mainDb, "COMMIT");
            await dbRun(req.db, "COMMIT");
        }
        
        touch();
        res.status(200).json({ success: true, message: "Costs updated successfully." });
    } catch (err) {
        console.error("Error updating part/BOM costs:", err);
        if (areDbsSame) {
            await dbRun(mainDb, "ROLLBACK").catch(e => console.error("Main DB Rollback failed:", e));
        } else {
            await dbRun(mainDb, "ROLLBACK").catch(e => console.error("Main DB Rollback failed:", e));
            await dbRun(req.db, "ROLLBACK").catch(e => console.error("Req DB Rollback failed:", e));
        }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/bom/simulations', withDb, async (req, res) => {
    const { name, data } = req.body;
    try {
        await dbRun(req.db, `INSERT OR REPLACE INTO bom_simulations (name, data) VALUES (?, ?)`, [name, JSON.stringify(data)]);
        touch();
        res.status(201).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/bom/simulations/:name', withDb, async (req, res) => {
    try {
        await dbRun(req.db, `DELETE FROM bom_simulations WHERE name = ?`, [decodeURIComponent(req.params.name)]);
        touch();
        res.sendStatus(204);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// --- NEW: Workshop Finance Endpoints ---
app.get('/api/workshop-finance/data', withDb, async (req, res) => {
    try {
        const workshops = await dbAll(req.db, "SELECT * FROM workshops ORDER BY name");
        const costs = await dbAll(req.db, "SELECT * FROM workshop_finance_costs ORDER BY timestamp DESC");
        const payments = await dbAll(req.db, "SELECT * FROM workshop_finance_payments ORDER BY paymentDate DESC");
        const wages_flat = await dbAll(req.db, "SELECT * FROM outsourcing_wages");
        const mainInventoryParts = await dbAll(req.db, "SELECT id, name FROM parts ORDER BY name");

        const wages = {};
        wages_flat.forEach(w => {
            if (!wages[w.workshopId]) wages[w.workshopId] = {};
            wages[w.workshopId][w.partId] = w.wage;
        });

        res.json({ workshops, costs, payments, wages, mainInventoryParts });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/workshop-finance/payments', withDb, async (req, res) => {
    const { id, workshopId, amount, paymentDate, chequeNumber, timestamp } = req.body;
    try {
        await dbRun(req.db, `INSERT INTO workshop_finance_payments (id, workshopId, amount, paymentDate, chequeNumber, timestamp) VALUES (?, ?, ?, ?, ?, ?)`, [id, workshopId, amount, paymentDate, chequeNumber, timestamp]);
        touch();
        res.status(201).json({ success: true, id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/workshop-finance/payments/:id', withDb, async (req, res) => {
    const { amount, paymentDate, chequeNumber } = req.body;
    try {
        await dbRun(req.db, `UPDATE workshop_finance_payments SET amount = ?, paymentDate = ?, chequeNumber = ? WHERE id = ?`, [amount, paymentDate, chequeNumber, req.params.id]);
        touch();
        res.status(200).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/workshop-finance/payments/:id', withDb, async (req, res) => {
    try {
        await dbRun(req.db, `DELETE FROM workshop_finance_payments WHERE id = ?`, [req.params.id]);
        touch();
        res.sendStatus(204);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/workshop-finance/costs', withDb, async (req, res) => {
    const { workshopId, partId, partName, quantity, costBase, unitWage, totalCost } = req.body;
    const id = `cost_manual_${Date.now()}`;
    const timestamp = new Date().toISOString();
    try {
        await dbRun(req.db, `INSERT INTO workshop_finance_costs (id, workshopId, partId, partName, quantity, costBase, unitWage, totalCost, timestamp, isManual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, workshopId, partId, partName, quantity, costBase, unitWage, totalCost, timestamp, true]);
        touch();
        res.status(201).json({ success: true, id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/workshop-finance/costs/:id', withDb, async (req, res) => {
    const { quantity, costBase, unitWage, totalCost } = req.body;
    try {
        await dbRun(req.db, `UPDATE workshop_finance_costs SET quantity = ?, costBase = ?, unitWage = ?, totalCost = ? WHERE id = ? AND isManual = 1`, [quantity, costBase, unitWage, totalCost, req.params.id]);
        touch();
        res.status(200).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/workshop-finance/costs/:id', withDb, async (req, res) => {
    try {
        await dbRun(req.db, `DELETE FROM workshop_finance_costs WHERE id = ? AND isManual = 1`, [req.params.id]);
        touch();
        res.sendStatus(204);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// --- Backup & Restore (Operates ONLY on main DB) ---
app.post('/api/backup', async (req, res) => {
    try {
        const users = await dbAll(mainDb, "SELECT * FROM users");
        const main_parts = await dbAll(mainDb, "SELECT * FROM parts");
        const main_transactions = await dbAll(mainDb, "SELECT * FROM transactions");
        const outsourcing_workshops = await dbAll(mainDb, "SELECT * FROM workshops");
        const production_rawMaterials = await dbAll(mainDb, "SELECT * FROM raw_materials");
        const production_rawMaterialTransactions = await dbAll(mainDb, "SELECT * FROM raw_material_transactions");
        const production_wipJobs = await dbAll(mainDb, "SELECT * FROM wip_jobs");
        const outsourcing_parts = await dbAll(mainDb, "SELECT * FROM outsourcing_parts");
        const outsourcing_transactions = await dbAll(mainDb, "SELECT * FROM outsourcing_transactions");
        const outsourcing_wages_flat = await dbAll(mainDb, "SELECT * FROM outsourcing_wages");
        const outsourcing_scrap_log = await dbAll(mainDb, "SELECT * FROM outsourcing_scrap_log");
        const calculator_saves = await dbAll(mainDb, "SELECT * FROM calculator_saves");
        const boms = await dbAll(mainDb, "SELECT * FROM boms");
        const bom_components = await dbAll(mainDb, "SELECT * FROM bom_components");
        const bom_simulations = await dbAll(mainDb, "SELECT * FROM bom_simulations");
        const workshop_finance_costs = await dbAll(mainDb, "SELECT * FROM workshop_finance_costs");
        const workshop_finance_payments = await dbAll(mainDb, "SELECT * FROM workshop_finance_payments");

        const outsourcing_wages = {};
        outsourcing_wages_flat.forEach(w => {
            if (!wages[w.workshopId]) wages[w.workshopId] = {};
            wages[w.workshopId][w.partId] = w.wage;
        });
        
        const backupData = {
            users: users.map(u => ({ ...u, permissions: JSON.parse(u.permissions || '{}') })),
            main_parts,
            main_transactions,
            outsourcing_workshops,
            production_rawMaterials,
            production_rawMaterialTransactions,
            production_wipJobs: production_wipJobs.map(j => ({ ...j, productions: JSON.parse(j.productions || '[]'), completionAction: JSON.parse(j.completionAction || 'null') })),
            outsourcing_parts: outsourcing_parts.map(p => ({ ...p, weightDefinition: JSON.parse(p.weightDefinition || 'null'), finalWorkshopIds: JSON.parse(p.finalWorkshopIds || '[]') })),
            outsourcing_transactions,
            outsourcing_wages,
            outsourcing_scrap_log,
            calculator_saves,
            boms,
            bom_components,
            bom_simulations,
            workshop_finance_costs,
            workshop_finance_payments,
        };
        
        res.json(backupData);
    } catch (err) {
        res.status(500).json({ error: `Backup failed: ${err.message}` });
    }
});

app.post('/api/restore', async (req, res) => {
    const data = req.body;

    // Close all existing connections, especially the main one.
    for (const key in dbConnections) {
        try {
            await dbClose(dbConnections[key]);
            delete dbConnections[key];
        } catch (err) {
            console.error(`Error closing DB connection for ${key}:`, err);
            // Continue even if closing fails
        }
    }

    // Delete the main database file
    try {
        if (fs.existsSync(DB_PATH)) {
            fs.unlinkSync(DB_PATH);
        }
    } catch (err) {
        return res.status(500).json({ error: `Failed to delete old DB: ${err.message}` });
    }

    // NOTE: The section that deleted personal user databases has been removed
    // to meet the new requirement. User DBs in './data-user' will persist.

    // Recreate and connect to the new main database
    const newMainDb = new sqlite3.Database(DB_PATH, async (err) => {
        if (err) {
            return res.status(500).json({ error: `Failed to create new DB: ${err.message}` });
        }

        mainDb = newMainDb; // Re-assign global mainDb
        dbConnections.main = newMainDb;

        try {
            createTables(newMainDb);

            await dbRun(newMainDb, "BEGIN TRANSACTION");

            // Use INSERT OR REPLACE for robustness
            if (data.users) for (const user of data.users) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO users (id, username, password, displayName, permissions, lastSeen) VALUES (?, ?, ?, ?, ?, ?)", [user.id, user.username, user.password, user.displayName, JSON.stringify(user.permissions || {}), user.lastSeen]);
            }
            if (data.main_parts) for (const part of data.main_parts) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO parts (id, name, quantity, itemsPerKg, reorderPoint, baseCount, baseWeight, reorderTriggeredDate, dailyUsage, leadTime, safetyStockDays, material_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [part.id, part.name, part.quantity, part.itemsPerKg, part.reorderPoint, part.baseCount, part.baseWeight, part.reorderTriggeredDate || null, part.dailyUsage || null, part.leadTime || null, part.safetyStockDays || null, part.material_cost || 0]);
            }
            if (data.main_transactions) for (const tx of data.main_transactions) {
                 await dbRun(newMainDb, "INSERT OR REPLACE INTO transactions (id, partId, partName, operation, quantityChange, weightChangeKg, timestamp, snapshotQuantity, snapshotWeightKg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [tx.id, tx.partId, tx.partName, tx.operation, tx.quantityChange, tx.weightChangeKg, tx.timestamp, tx.snapshotQuantity, tx.snapshotWeightKg]);
            }
            if (data.outsourcing_workshops) for (const ws of data.outsourcing_workshops) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO workshops (id, name) VALUES (?, ?)", [ws.id, ws.name]);
            }
            if (data.production_rawMaterials) for (const rm of data.production_rawMaterials) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO raw_materials (id, name, unit) VALUES (?, ?, ?)", [rm.id, rm.name, rm.unit]);
            }
            if (data.production_rawMaterialTransactions) for (const tx of data.production_rawMaterialTransactions) {
                 await dbRun(newMainDb, "INSERT OR REPLACE INTO raw_material_transactions (id, rawMaterialId, type, quantity, notes, timestamp, wipJobId, workshopId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [tx.id, tx.rawMaterialId, tx.type, tx.quantity, tx.notes, tx.timestamp, tx.wipJobId, tx.workshopId]);
            }
            if (data.production_wipJobs) for (const job of data.production_wipJobs) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO wip_jobs (id, rawMaterialId, workshopId, consumedQuantity, timestamp, status, productions, completionAction, completionNotes, completionTimestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [job.id, job.rawMaterialId, job.workshopId, job.consumedQuantity, job.timestamp, job.status, JSON.stringify(job.productions || []), JSON.stringify(job.completionAction || job.completion_action || null), job.completionNotes || job.completion_notes || job.notes || null, job.completionTimestamp || job.completion_timestamp || null]);
            }
            if (data.outsourcing_parts) for (const p of data.outsourcing_parts) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO outsourcing_parts (id, name, description, isRawMaterialProduct, weightDefinition, finalWorkshopIds) VALUES (?, ?, ?, ?, ?, ?)", [p.id, p.name, p.description, p.isRawMaterialProduct, JSON.stringify(p.weightDefinition), JSON.stringify(p.finalWorkshopIds)]);
            }
            if (data.outsourcing_transactions) for (const tx of data.outsourcing_transactions) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO outsourcing_transactions (id, partId, type, quantity, fromWorkshopId, toWorkshopId, notes, timestamp, lastEdited) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [tx.id, tx.partId, tx.type, tx.quantity, tx.fromWorkshopId, tx.toWorkshopId, tx.notes, tx.timestamp, tx.lastEdited]);
            }
            if (data.outsourcing_wages) {
                for (const [wsId, pWages] of Object.entries(data.outsourcing_wages)) {
                    for (const [pId, wage] of Object.entries(pWages)) {
                        await dbRun(newMainDb, "INSERT OR REPLACE INTO outsourcing_wages (workshopId, partId, wage) VALUES (?, ?, ?)", [wsId, pId, wage]);
                    }
                }
            }
            if (data.outsourcing_scrap_log) for (const log of data.outsourcing_scrap_log) {
                 const columns = [
                    'id', 'workshopId', 'timestamp', 'scrap_kg', 'process_description', 
                    'type', 'sourcePartId', 'resultingPartId', 'sourceQuantity', 
                    'originalScrapKg', 'destinationWorkshopId', 'returnedQuantity', 'actualReturnedWeightKg'
                ];
                const placeholders = columns.map(() => '?').join(', ');
                const values = columns.map(col => log[col] || null); // Use null for missing properties in old backups
                await dbRun(newMainDb, `INSERT OR REPLACE INTO outsourcing_scrap_log (${columns.join(', ')}) VALUES (${placeholders})`, values);
            }
            if (data.workshop_finance_costs) for (const cost of data.workshop_finance_costs) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO workshop_finance_costs (id, workshopId, partId, partName, quantity, unitWage, totalCost, costBase, timestamp, isManual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [cost.id, cost.workshopId, cost.partId, cost.partName, cost.quantity, cost.unitWage, cost.totalCost, cost.costBase, cost.timestamp, cost.isManual]);
            }
            if (data.workshop_finance_payments) for (const payment of data.workshop_finance_payments) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO workshop_finance_payments (id, workshopId, amount, paymentDate, chequeNumber, timestamp) VALUES (?, ?, ?, ?, ?, ?)", [payment.id, payment.workshopId, payment.amount, payment.paymentDate, payment.chequeNumber, payment.timestamp]);
            }
            if (data.calculator_saves) for (const save of data.calculator_saves) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO calculator_saves (name, data) VALUES (?, ?)", [save.name, save.data]);
            }
            if (data.boms) for (const bom of data.boms) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO boms (id, name) VALUES (?, ?)", [bom.id, bom.name]);
            }
            if (data.bom_components) for (const comp of data.bom_components) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO bom_components (id, bom_id, part_id, part_name, quantity, cost) VALUES (?, ?, ?, ?, ?, ?)", [comp.id, comp.bom_id, comp.part_id, comp.part_name, comp.quantity, comp.cost]);
            }
            if (data.bom_simulations) for (const sim of data.bom_simulations) {
                await dbRun(newMainDb, "INSERT OR REPLACE INTO bom_simulations (name, data) VALUES (?, ?)", [sim.name, sim.data]);
            }
            
            await dbRun(newMainDb, "COMMIT");
            
            // Ensure trade_master always has full admin rights after restore.
            const allPermissions = {
                canViewMainWarehouse: true, canEditMainWarehouse: true,
                canAddItems: true, canPerformTransactions: true, canEditItems: true, canDeleteItems: true,
                canViewProduction: true, canEditProduction: true,
                canViewOutsourcing: true, canEditOutsourcing: true,
                canViewWipReport: true, canEditWipReport: true,
                canViewWorkshopCosts: true, canEditWorkshopCosts: true,
                canViewUsers: true, canEditUsers: true,
            };
            await dbRun(newMainDb, `UPDATE users SET permissions = ? WHERE username = ?`, [JSON.stringify(allPermissions), 'trade_master']);

            touch();
            res.status(200).json({ success: true, message: 'Restore successful. Please refresh.' });

        } catch (dbErr) {
            console.error("Error during restore transaction:", dbErr);
            try { await dbRun(newMainDb, "ROLLBACK"); } catch (rbErr) { console.error("Rollback failed:", rbErr); }
            res.status(500).json({ error: `Restore transaction failed: ${dbErr.message}` });
        }
    });
});


// Fallback to index.html for single-page app routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
