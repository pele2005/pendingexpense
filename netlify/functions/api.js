
// 4. PERMISSION_SHEET_ID

const getServiceAccountAuth = () => {
    try {
        const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDS_JSON);
        return new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
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
            
            // ดึงชื่อหัวคอลัมน์จากตำแหน่ง (A=0, B=1)
            const userHeader = sheet.headerValues[0]; // ชื่อหัวคอลัมน์ A
            const passHeader = sheet.headerValues[1]; // ชื่อหัวคอลัมน์ B

            const user = rows.find(row => {
                // อ่านข้อมูลโดยอ้างอิงจากชื่อหัวคอลัมน์ที่ดึงมาตามตำแหน่ง
                const sheetUser = String(row.get(userHeader) || '').trim();
                const sheetPass = String(row.get(passHeader) || '').trim();

                const inputUser = String(username).trim();
                const inputPass = String(password).trim();

                const isUserMatch = sheetUser.toLowerCase() === inputUser.toLowerCase();
                const isPassMatch = sheetPass === inputPass;
                
                return isUserMatch && isPassMatch;
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
            const permUserHeader = permSheet.headerValues[0]; // คอลัมน์ A
            const permAccessHeader = permSheet.headerValues[1]; // คอลัมน์ B

            const userPermissions = permRows.find(row => String(row.get(permUserHeader) || '').trim() === costCenter);
            let accessibleCostCenters = [costCenter];
            if (userPermissions && userPermissions.get(permAccessHeader)) {
                 const additionalPermissions = userPermissions.get(permAccessHeader).split(',').map(item => item.trim()).filter(Boolean);
                 accessibleCostCenters = [...new Set([...accessibleCostCenters, ...additionalPermissions])];
            }
            
            const expenseDoc = new GoogleSpreadsheet(process.env.EXPENSE_SHEET_ID, auth);
            await expenseDoc.loadInfo();
            const expenseSheet = expenseDoc.sheetsByIndex[0];
            const expenseRows = await expenseSheet.getRows();
            await expenseSheet.loadCells('AB2');
            const updateDateCell = expenseSheet.getCellByA1('AB2');
            const lastUpdate = updateDateCell.formattedValue || 'ไม่ระบุ';
            const statusesToFind = ['รอแนบใบเสร็จ', 'รอแนบใบตอบรับ'];

            const expenseCostCenterHeader = expenseSheet.headerValues.find(h => h.toLowerCase().includes('cost center'));
            const expenseStatusHeader = expenseSheet.headerValues.find(h => h.toLowerCase().includes('status'));

            const filteredData = expenseRows
                .filter(row => {
                    const rowCostCenter = String(row.get(expenseCostCenterHeader) || '').trim();
                    const rowStatus = String(row.get(expenseStatusHeader) || '').trim();
                    return accessibleCostCenters.includes(rowCostCenter) && statusesToFind.includes(rowStatus);
                })
                .map(row => row.toObject());
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
