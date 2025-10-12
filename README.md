# bar-scanner
Minimal webapp to scan bars

## Features
- Simple one-button interface
- Scan barcodes and QR codes using your phone's camera
- Display scanned codes in a read-only text area with timestamps
- Mobile-friendly responsive design

## Usage
1. Open `index.html` in a mobile browser
2. Click the "Scan" button to start scanning
3. Point your camera at a barcode or QR code
4. The decoded value will appear in the text area
5. Click "Stop Scanning" to stop the camera

## Technical Details
- Uses html5-qrcode library for scanning functionality
- Includes fallback support for native BarcodeDetector API
- No build process required - just open index.html in a browser
- Supports various barcode formats (EAN, UPC, Code 128, QR codes, etc.)
