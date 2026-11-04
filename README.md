# Gatehouse

    pip install -r requirements.txt
    python app.py            # http://127.0.0.1:5000
    python tests.py          # pricing, access control, last-ticket race

Layout (keep it exactly like this):

    app.py
    tests.py
    requirements.txt
    templates/  login.html  attendee.html  organizer.html
    static/     style.css   common.js

Optional environment variables:

    ORGANIZER_CODE=...   require this code to register as an organizer
    SECRET_KEY=...       session signing key (otherwise generated into .secret_key)
    COOKIE_SECURE=1      set when serving over HTTPS
    TICKETS_DB=path.db   database location (default gatehouse.db)
