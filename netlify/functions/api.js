// ไฟล์นี้จะต้องอยู่ในโฟลเดอร์ netlify/functions/ ภายในโปรเจคของคุณ
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// --- ข้อมูลสำคัญที่ต้องตั้งค่าใน Environment Variables ของ Netlify ---
// 1. GOOGLE_SERVICE_ACCOUNT_CREDS_JSON
// 2. EXPENSE_SHEET_ID
// 3. USER_SHEET_ID
// 4. PERMISSION_SHEET_ID

const getServiceAccountAuth = () => {
    try {
        const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDS_JSON);
        return new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    } catch (error) {
        console.error("Failed to parse GOOGLE_SERVICE_ACCOUNT_CREDS_JSON:", error);
        throw new Error("Service Account credentials are not configured correctly.");
    }
};

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'Successful preflight call.' }) };
    }

    try {
        const payload = JSON.parse(event.body);
        const action = payload.action;
        const auth = getServiceAccountAuth();

        // --- Action: Login ---
        if (action === 'login') {
            const { username, password } = payload;
            const doc = new GoogleSpreadsheet(process.env.USER_SHEET_ID, auth);
            await doc.loadInfo();
            const sheet = doc.sheetsByIndex[0];
            const rows = await sheet.getRows();
            
            const userHeader = sheet.headerValues[0];
            const passHeader = sheet.headerValues[1];

            const user = rows.find(row => {
                const sheetUser = String(row.get(userHeader) || '').trim();
                const sheetPass = String(row.get(passHeader) || '').trim();
                const inputUser = String(username).trim();
                const inputPass = String(password).trim();
                return sheetUser.toLowerCase() === inputUser.toLowerCase() && sheetPass === inputPass;
            });

            if (user) {
                return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Login successful' }) };
            } else {
                return { statusCode: 401, headers, body: JSON.stringify({ success: false, message: 'Cost Center หรือรหัสผ่านไม่ถูกต้อง' }) };
            }
        }

        // --- Action: Get Data ---
        if (action === 'getData') {
            const { costCenter } = payload;
            const permDoc = new GoogleSpreadsheet(process.env.PERMISSION_SHEET_ID, auth);
            await permDoc.loadInfo();
            const permSheet = permDoc.sheetsByIndex[0];
            const permRows = await permSheet.getRows();
            
            const permUserHeader = permSheet.headerValues[0]; 
            
            const userPermissionRow = permRows.find(row => String(row.get(permUserHeader) || '').trim() === costCenter);
            
            let accessibleCostCenters = [costCenter];

            if (userPermissionRow) {
                for (let i = 1; i < permSheet.headerValues.length; i++) {
                    const header = permSheet.headerValues[i];
                    const permissionValue = userPermissionRow.get(header);
                    
                    if (permissionValue) {
                        accessibleCostCenters.push(String(permissionValue).trim());
                    }
                }
            }
            accessibleCostCenters = [...new Set(accessibleCostCenters)];

            const expenseDoc = new GoogleSpreadsheet(process.env.EXPENSE_SHEET_ID, auth);
            await expenseDoc.loadInfo();
            const expenseSheet = expenseDoc.sheetsByIndex[0];
            
            await expenseSheet.loadCells('AB2');
            const updateDateCell = expenseSheet.getCellByA1('AB2');
            const lastUpdate = updateDateCell.formattedValue || 'ไม่ระบุ';

            const expenseRows = await expenseSheet.getRows();
            const statusesToFind = ['รอแนบใบเสร็จ', 'รอแนบใบตอบขอบคุณ'];

            const expenseCostCenterHeader = expenseSheet.headerValues.find(h => h && h.toLowerCase().replace(/[\s_]/g, '').includes('costcenter'));
            const expenseStatusHeader = expenseSheet.headerValues.find(h => h && h.toLowerCase().replace(/[\s_]/g, '').includes('status'));

            if (!expenseCostCenterHeader || !expenseStatusHeader) {
                throw new Error("Could not find 'Cost Center' or 'Status' header in the expense sheet.");
            }

            // === จุดที่แก้ไข 1: อัปเดตคอลัมน์ที่จะแสดงผล (ตัด J และ V ออก) ===
            // ตำแหน่งคอลัมน์: A,E,H,I,K,L,M,N,O,P,Q,R,S,T,W
            const columnIndicesToShow = [0, 4, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 22];
            
            const allHeaders = expenseSheet.headerValues;
            const headersToShow = columnIndicesToShow.map(index => allHeaders[index]).filter(Boolean);

            let filteredData = expenseRows
                .filter(row => {
                    const rowCostCenter = String(row.get(expenseCostCenterHeader) || '').trim();
                    const rowStatus = String(row.get(expenseStatusHeader) || '').trim();
                    return accessibleCostCenters.includes(rowCostCenter) && statusesToFind.includes(rowStatus);
                })
                .map(row => {
                    const cleanObject = {};
                    headersToShow.forEach(header => {
                        cleanObject[header] = row.get(header) || '';
                    });
                    return cleanObject;
                });

            // === จุดที่แก้ไข 2: เรียงลำดับข้อมูลตามวันที่ในคอลัมน์ A ===
            const dateHeader = allHeaders[0]; // กำหนดให้คอลัมน์ A (index 0) คือคอลัมน์วันที่

            const parseDate = (dateString) => {
                if (!dateString || typeof dateString !== 'string') return null;
                const parts = dateString.split(/[/.-]/); // รองรับวันที่คั่นด้วย / . หรือ -
                if (parts.length === 3) {
                    // new Date(year, monthIndex, day) -> DD/MM/YYYY
                    const day = parseInt(parts[0], 10);
                    const month = parseInt(parts[1], 10) - 1; // เดือนใน JS เริ่มที่ 0
                    const year = parseInt(parts[2], 10);
                    if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
                        return new Date(year, month, day);
                    }
                }
                return null;
            };

            filteredData.sort((a, b) => {
                const dateA = parseDate(a[dateHeader]);
                const dateB = parseDate(b[dateHeader]);

                if (!dateA) return 1;  // ย้ายรายการที่ไม่มีวันที่ไปไว้ท้ายๆ
                if (!dateB) return -1; // ย้ายรายการที่ไม่มีวันที่ไปไว้ท้ายๆ

                return dateA - dateB; // เรียงจากเก่าไปใหม่ (Ascending)
            });

            return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: filteredData, lastUpdate: lastUpdate }) };
        }

        return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'Invalid action' }) };

    } catch (error) {
        console.error('API Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, message: 'เกิดข้อผิดพลาดภายใน Server: ' + error.message })
        };
    }
};
