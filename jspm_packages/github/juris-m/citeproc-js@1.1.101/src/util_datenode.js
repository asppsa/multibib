/*global CSL: true */

CSL.Util.fixDateNode = function (parent, pos, node) {
    var form, variable, datexml, subnode, partname, attr, val, prefix, suffix, children, key, subchildren, kkey, display, cslid;
    
    // Raise date flag, used to control inclusion of year-suffix key in sorts
    // This may be a little reckless: not sure what happens on no-date conditions
    this.build.date_key = true;

    form = this.cslXml.getAttributeValue(node, "form");
    var lingo;
    if ("accessed" === this.cslXml.getAttributeValue(node, "variable")) {
        lingo = this.opt["default-locale"][0];
    } else {
        lingo = this.cslXml.getAttributeValue(node, "lingo");
    }

    if (!this.getDate(form)) {
        return parent;
    }

    var dateparts = this.cslXml.getAttributeValue(node, "date-parts");

    variable = this.cslXml.getAttributeValue(node, "variable");
    prefix = this.cslXml.getAttributeValue(node, "prefix");
    suffix = this.cslXml.getAttributeValue(node, "suffix");
    display = this.cslXml.getAttributeValue(node, "display");
    cslid = this.cslXml.getAttributeValue(node, "cslid");
    
    //
    // Xml: Copy a node
    //
    datexml = this.cslXml.nodeCopy(this.getDate(form, ("accessed" === variable)));
    this.cslXml.setAttribute(datexml, 'lingo', this.opt.lang);
    this.cslXml.setAttribute(datexml, 'form', form);
    this.cslXml.setAttribute(datexml, 'date-parts', dateparts);
    this.cslXml.setAttribute(datexml, "cslid", cslid);
    //
    // Xml: Set attribute
    //
    this.cslXml.setAttribute(datexml, 'variable', variable);
    //
    // Xml: Set flag
    //
    if (prefix) {
        //
        // Xml: Set attribute
        //
        this.cslXml.setAttribute(datexml, "prefix", prefix);
    }
    if (suffix) {
        //
        // Xml: Set attribute
        //
        this.cslXml.setAttribute(datexml, "suffix", suffix);
    }
    if (display) {
        //
        // Xml: Set attribute
        //
        this.cslXml.setAttribute(datexml, "display", display);
    }
    //
    // Step through any date-part children of the layout date node,
    // and lay their attributes onto the corresponding node in the
    // locale template node copy.
    //
    // tests: language_BaseLocale
    // tests: date_LocalizedTextInStyleLocaleWithTextCase
    // 
    children = this.cslXml.children(node);
    for (key in children) {
        // Ah. Object children is XML. Can pass it along,
        // but hasOwnProperty() won't work on it.
        //if (children.hasOwnProperty(key)) {
            // lie to jslint
            subnode = children[key];
            if ("date-part" === this.cslXml.nodename(subnode)) {
                partname = this.cslXml.getAttributeValue(subnode, "name");
                subchildren = this.cslXml.attributes(subnode);
                for (attr in subchildren) {
                    if (subchildren.hasOwnProperty(attr)) {
                        if ("@name" === attr) {
                            continue;
                        }
                        if (lingo && lingo !== this.opt.lang) {
                            if (["@suffix", "@prefix", "@form"].indexOf(attr) > -1) {
                                continue;
                            }
                        }
                        val = subchildren[attr];
                        this.cslXml.setAttributeOnNodeIdentifiedByNameAttribute(datexml, "date-part", partname, attr, val);
                    }
                }
            }
            //}
    }
    
    if ("year" === this.cslXml.getAttributeValue(node, "date-parts")) {

        //
        // Xml: Find one node by attribute and delete
        //
        this.cslXml.deleteNodeByNameAttribute(datexml, 'month');
        //
        // Xml: Find one node by attribute and delete
        //
        this.cslXml.deleteNodeByNameAttribute(datexml, 'day');
        
    } else if ("year-month" === this.cslXml.getAttributeValue(node, "date-parts")) {
        //
        // Xml: Find one node by attribute and delete
        //
        this.cslXml.deleteNodeByNameAttribute(datexml, 'day');
    }
    return this.cslXml.insertChildNodeAfter(parent, node, pos, datexml);
};
