from pynput import keyboard

def on_press(key):
    try:
        print('key: {0} \n'.format(
            key.char,))
    except AttributeError:
        print('special key {0}'.format(
            key
        ))
        

def on_release(key):
    if key == keyboard.Key.esc:
        return False


# Collect events until released
with keyboard.Listener(
        on_press=on_press,
        on_release=on_release) as listener:
    listener.join()


listener = keyboard.Listener(
    on_press=on_release,
    on_release=on_release)

listener.start()