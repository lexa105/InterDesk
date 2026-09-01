import serial
import time

# --- Configuration ---
# !! IMPORTANT: REPLACE WITH YOUR ARDUINO'S ACTUAL PORT !!
ARDUINO_PORT = '/dev/cu.usbserial-10'
BAUD_RATE = 115200 # Must match Serial.begin() on Arduino

def send_to_arduino(message):
    try:
        # Open the serial port
        # timeout=1 means it will wait for up to 1 second to read/write
        ser = serial.Serial(ARDUINO_PORT, BAUD_RATE, timeout=1)
        time.sleep(2) # Give the connection time to establish (especially on Windows/Linux, good practice on Mac too)
        print(f"Connected to {ARDUINO_PORT} at {BAUD_RATE} baud.")

        # Encode the message to bytes and send it. Add a newline as a terminator.
        message_bytes = (message + '\n').encode('utf-8')
        ser.write(message_bytes)
        print(f"Sent: '{message}'")

        # Optionally, read a response from Arduino if it sends one back
        # response = ser.readline().decode('utf-8').strip()
        # if response:
        #     print(f"Arduino replied: '{response}'")

    except serial.SerialException as e:
        print(f"Error connecting to or communicating with Arduino: {e}")
        print(f"Please check if {ARDUINO_PORT} is correct and if Arduino is connected and not busy.")
    finally:
        # Always close the port when done, or when an error occurs
        if 'ser' in locals() and ser.is_open:
            ser.close()
            print("Serial port closed.")

if __name__ == "__main__":
    send_to_arduino("This is a test message from my Mac!")
    time.sleep(1) # Give it a moment before exiting
    send_to_arduino("Another message!")